import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, documentSuggestions, documents, vendors } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { actorFromResolved, buildExecutor, buildRegistry, createDbModuleGate } from "@/server/kernel";
import { enqueueCapabilityJob } from "@/server/jobs";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";
import { logger } from "@chaste/kernel";

const noStore = { "Cache-Control": "no-store" };
const ingestedDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  sourceType: z.string(),
  createdAt: z.string().datetime(),
  folder: z.string().nullable(),
}).strict();
const ingestedVendorSchema = z.object({ id: z.string().uuid(), name: z.string() }).strict();
const ingestedSuggestionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  documentId: z.string().uuid(),
  description: z.string(),
  quantityThousandths: z.number().int(),
  unitPriceMinor: z.number().int(),
  suggestedAccountCode: z.string(),
  matchScore: z.number().int(),
  matchedOn: z.unknown(),
  status: z.string(),
  createdAt: z.string().datetime(),
}).strict();
const ingestedDocumentDetailSchema = z.object({
  ...ingestedDocumentSchema.shape,
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  parseError: z.string().nullable(),
  parsedMarkdown: z.string().nullable(),
  suggestions: z.array(ingestedSuggestionSchema).optional(),
}).strict();
const ingestedReadOutputSchema = z.union([
  z.object({ documents: z.array(ingestedDocumentSchema), vendors: z.array(ingestedVendorSchema) }).strict(),
  z.object({ document: ingestedDocumentDetailSchema }).strict(),
]);

async function ingestedDocumentsGoResponse(result: GoCapabilityBridgeResult, preview: boolean) {
  const unavailable = () => NextResponse.json({ error: "Go documents service unavailable" }, { status: 503, headers: noStore });
  if (result.kind !== "response") return unavailable();
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: ingestedReadOutputSchema }).strict().safeParse(body);
      if (!parsed.success) return unavailable();
      const data = parsed.data.data;
      if (preview && "document" in data && data.document.suggestions !== undefined) return unavailable();
      return NextResponse.json(data, { headers: noStore });
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      return parsed.success ? NextResponse.json(parsed.data, { status: result.response.status, headers: noStore }) : unavailable();
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      if (parsed.data.error === "ingested document not found") return NextResponse.json({ error: "not found" }, { status: 404, headers: noStore });
    }
  } catch {
    logger.warn("Go ingested documents read returned an invalid response");
  }
  return unavailable();
}

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const orgId = resolved.orgId;
  if (!(await createDbModuleGate(db).isEnabled(orgId, "documents"))) {
    return NextResponse.json({ error: "documents module is disabled" }, { status: 403 });
  }

  const searchParams = new URL(req.url).searchParams;
  const id = searchParams.get("id");
  const preview = searchParams.get("preview") === "1";
  if (process.env.GO_DOCUMENT_INGESTED_READS === "1") {
    const ctx = actorFromResolved(resolved, {});
    if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
    if (ctx.actor.type !== "human" || ctx.actor.id !== resolved.userId || ctx.actor.orgId !== resolved.orgId || !resolved.authSessionId) {
      return NextResponse.json({ error: "Go documents service unavailable" }, { status: 503, headers: noStore });
    }
    const result = await executeGoCapability({
      actionContext: ctx,
      session: resolved,
      capabilityId: "documents.listIngestedDocuments",
      input: { ...(id ? { id } : {}), ...(id && preview ? { preview: true } : {}) },
    });
    return ingestedDocumentsGoResponse(result, Boolean(id && preview));
  }
  if (id) {
    const [doc] = await db
      .select({
        id: documents.id,
        title: documents.title,
        status: documents.status,
        sourceType: documents.sourceType,
        mimeType: documents.mimeType,
        sizeBytes: documents.sizeBytes,
        parseError: documents.parseError,
        parsedMarkdown: documents.parsedMarkdown,
        createdAt: documents.createdAt,
        folder: documents.folder,
      })
      .from(documents)
      .where(and(eq(documents.orgId, orgId), eq(documents.id, id)))
      .limit(1);
    if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
    const suggestions = preview ? undefined : await db
      .select()
      .from(documentSuggestions)
      .where(and(eq(documentSuggestions.orgId, orgId), eq(documentSuggestions.documentId, id)))
      .orderBy(desc(documentSuggestions.createdAt));
    return NextResponse.json({
      document: {
        id: doc.id,
        title: doc.title,
        status: doc.status,
        sourceType: doc.sourceType,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        parseError: doc.parseError,
        parsedMarkdown: doc.parsedMarkdown,
        createdAt: doc.createdAt.toISOString(),
        folder: doc.folder,
      },
      ...(suggestions ? { suggestions } : {}),
    });
  }

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      sourceType: documents.sourceType,
      createdAt: documents.createdAt,
      folder: documents.folder,
    })
    .from(documents)
    .where(eq(documents.orgId, orgId))
    .orderBy(desc(documents.createdAt))
    .limit(100);

  const vendorList = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(eq(vendors.orgId, orgId));

  return NextResponse.json({
    documents: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    vendors: vendorList,
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const body = (await req.json()) as {
    action?: string;
    title?: string;
    text?: string;
    fileBase64?: string;
    mimeType?: string;
    folder?: string;
    documentId?: string;
    sync?: boolean;
    intentId?: string;
    lines?: { description: string; quantityThousandths?: number; unitPriceMinor?: number }[];
  };
  const intentId = typeof body.intentId === "string" ? body.intentId : undefined;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  switch (body.action) {
    case "create": {
      const result = await executor.execute("documents.createDocument", ctx, {
        title: body.title ?? "",
        folder: body.folder?.trim() || undefined,
        ...(body.fileBase64
          ? { fileBase64: body.fileBase64, mimeType: body.mimeType }
          : { text: body.text }),
      });
      return respond(result);
    }
    case "parse": {
      if (!body.documentId) return NextResponse.json({ error: "documentId required" }, { status: 400 });
      // OCR/embeddings are slow provider calls; queue by default so the
      // request returns immediately and the worker does the governed work.
      if (!body.sync) {
        await enqueueCapabilityJob(db, {
          orgId: ctx.actor.orgId,
          type: "documents.parseDocument",
          payload: { documentId: body.documentId },
          createdByActorType: ctx.actor.type,
          createdByActorId: ctx.actor.id,
        });
        await db
          .update(documents)
          .set({ status: "queued", parseError: null, updatedAt: new Date() })
          .where(and(eq(documents.orgId, ctx.actor.orgId), eq(documents.id, body.documentId)));
        return NextResponse.json({ ok: true, queued: true, documentId: body.documentId });
      }
      const result = await executor.execute("documents.parseDocument", ctx, { documentId: body.documentId });
      return respond(result);
    }
    case "suggest": {
      if (!body.documentId) return NextResponse.json({ error: "documentId required" }, { status: 400 });
      const lines = body.lines?.map((l) => ({
        description: l.description,
        quantityThousandths: l.quantityThousandths ?? 1000,
        unitPriceMinor: l.unitPriceMinor ?? 0,
      }));
      const result = await executor.execute(
        "documents.suggestCoding",
        ctx,
        lines && lines.length > 0 ? { documentId: body.documentId, lines } : { documentId: body.documentId },
      );
      return respond(result);
    }
    case "delete": {
      if (!body.documentId) return NextResponse.json({ error: "documentId required" }, { status: 400 });
      const result = await executor.execute("documents.deleteDocument", ctx, { documentId: body.documentId });
      return respond(result);
    }
    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
