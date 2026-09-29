import { NextResponse } from "next/server";
import { z } from "zod";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { getDb } from "@chaste/db";
import { ensureBuiltinTemplates } from "@/server/doc-templates";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };
const authoredDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  versions: z.number().int().nonnegative(),
  templateId: z.string().uuid().nullable(),
  folder: z.string().nullable(),
  documentType: z.string().nullable(),
  linkedRecordType: z.string().nullable(),
  linkedRecordId: z.string().uuid().nullable(),
  linkedRecordLabel: z.string().nullable(),
  updatedAt: z.string().datetime(),
}).strict();
const listDocsOutputSchema = z.object({ documents: z.array(authoredDocumentSchema) }).strict();

async function listDocsFromGo(result: GoCapabilityBridgeResult): Promise<{ documents: unknown[] } | Response> {
  const unavailable = () => NextResponse.json({ error: "Go documents service unavailable" }, { status: 503, headers: noStore });
  if (result.kind !== "response") return unavailable();
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: listDocsOutputSchema }).strict().safeParse(body);
      return parsed.success ? parsed.data.data : unavailable();
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      return parsed.success
        ? NextResponse.json(parsed.data, { status: result.response.status, headers: noStore })
        : unavailable();
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      return parsed.success ? NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore }) : unavailable();
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

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
  let documents: unknown[];
  if (process.env.GO_DOCUMENTS_LIST_READS === "1") {
    if (ctx.actor.type !== "human" || ctx.actor.id !== resolved.userId || ctx.actor.orgId !== resolved.orgId || !resolved.authSessionId) {
      return NextResponse.json({ error: "Go documents service unavailable" }, { status: 503, headers: noStore });
    }
    const result = await executeGoCapability({ actionContext: ctx, session: resolved, capabilityId: "documents.listDocs", input: {} });
    const goDocs = await listDocsFromGo(result);
    if (goDocs instanceof Response) return goDocs;
    documents = goDocs.documents;
  } else {
    const docs = await executor.execute("documents.listDocs", ctx, {});
    if (!docs.ok) return NextResponse.json({ error: docs.error }, { status: 422 });
    const docRows = (docs.data ?? {}) as { documents?: unknown[] };
    documents = docRows.documents ?? [];
  }
  const templates = await executor.execute("documents.listTemplates", ctx, {});
  if (!templates.ok) return NextResponse.json({ error: templates.error }, { status: 422 });
  const tplRows = (templates.data ?? {}) as { templates?: unknown[] };
  return NextResponse.json({
    documents,
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
    folder: z.string().max(300).optional(),
    documentType: z.string().max(60).optional(),
    linkedRecordType: z.string().max(60).optional(),
    linkedRecordId: z.string().uuid().optional(),
    linkedRecordLabel: z.string().max(240).optional(),
    pageSettings: z.object({ size: z.enum(["A4", "Letter"]), orientation: z.enum(["portrait", "landscape"]), margin: z.enum(["compact", "normal", "wide"]) }).optional(),
    intentId: z.string().optional(),
  }),
  z.object({
    action: z.literal("createTemplate"),
    name: z.string().min(1).max(120),
    description: z.string().max(300).optional(),
    content: contentSchema,
    intentId: z.string().optional(),
  }),
  z.object({ action: z.literal("delete"), documentId: z.string().uuid(), intentId: z.string().optional() }),
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
      case "delete":
        return executor.execute("documents.deleteDoc", ctx, { documentId: parsed.data.documentId });
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
  return NextResponse.json(result.data ?? { ok: true });
}
