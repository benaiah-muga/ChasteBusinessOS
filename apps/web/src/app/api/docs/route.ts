import { NextResponse } from "next/server";
import { z } from "zod";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { getDb } from "@chaste/db";
import { ensureBuiltinTemplates } from "@/server/doc-templates";

/**
 * Authored documents gallery: list (with built-in template seeding) and
 * create. Thin route - auth plus dispatch; rules live in the capabilities.
 */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const templateId = new URL(req.url).searchParams.get("template");
  if (templateId) {
    const tpl = await executor.execute("documents.getTemplate", ctx, { templateId });
    if (!tpl.ok) return NextResponse.json({ error: tpl.error }, { status: 404 });
    const payload = (tpl.data ?? {}) as { template?: unknown };
    return NextResponse.json({ template: payload.template ?? null });
  }

  await ensureBuiltinTemplates(db, resolved.orgId);
  const docs = await executor.execute("documents.listDocs", ctx, {});
  const templates = await executor.execute("documents.listTemplates", ctx, {});
  if (!docs.ok) return NextResponse.json({ error: docs.error }, { status: 422 });
  if (!templates.ok) return NextResponse.json({ error: templates.error }, { status: 422 });
  const docRows = (docs.data ?? {}) as { documents?: unknown[] };
  const tplRows = (templates.data ?? {}) as { templates?: unknown[] };
  return NextResponse.json({
    documents: docRows.documents ?? [],
    templates: tplRows.templates ?? [],
  });
}

const contentSchema = z.record(z.string(), z.unknown());

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().min(1).max(200),
    content: contentSchema,
    html: z.string().max(2_000_000),
    templateId: z.string().uuid().optional(),
    intentId: z.string().optional(),
  }),
  z.object({
    action: z.literal("createTemplate"),
    name: z.string().min(1).max(120),
    description: z.string().max(300).optional(),
    content: contentSchema,
    intentId: z.string().optional(),
  }),
  z.object({ action: z.literal("deleteTemplate"), templateId: z.string().uuid(), intentId: z.string().optional() }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const result = await (async () => {
    switch (parsed.data.action) {
      case "create":
        return executor.execute("documents.createDoc", ctx, parsed.data);
      case "createTemplate":
        return executor.execute("documents.createTemplate", ctx, parsed.data);
      case "deleteTemplate":
        return executor.execute("documents.deleteTemplate", ctx, { templateId: parsed.data.templateId });
    }
  })();

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
