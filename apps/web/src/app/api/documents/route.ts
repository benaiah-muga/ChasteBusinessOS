import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb, documentSuggestions, documents, vendors } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const orgId = resolved.orgId;

  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.orgId, orgId), eq(documents.id, id)))
      .limit(1);
    if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
    const suggestions = await db
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
        parseError: doc.parseError,
        parsedMarkdown: doc.parsedMarkdown,
        createdAt: doc.createdAt.toISOString(),
      },
      suggestions,
    });
  }

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      sourceType: documents.sourceType,
      createdAt: documents.createdAt,
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
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const executor = buildExecutor(getDb().db, buildRegistry(getDb().db));
  const body = (await req.json()) as {
    action?: string;
    title?: string;
    text?: string;
    fileBase64?: string;
    mimeType?: string;
    documentId?: string;
    lines?: { description: string; quantityThousandths?: number; unitPriceMinor?: number }[];
  };

  switch (body.action) {
    case "create": {
      const result = await executor.execute("documents.createDocument", ctx, {
        title: body.title ?? "",
        ...(body.fileBase64
          ? { fileBase64: body.fileBase64, mimeType: body.mimeType }
          : { text: body.text }),
      });
      return respond(result);
    }
    case "parse": {
      if (!body.documentId) return NextResponse.json({ error: "documentId required" }, { status: 400 });
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
