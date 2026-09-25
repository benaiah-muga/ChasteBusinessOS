import { NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { accounts, getDb, customers, documentSuggestions, documents, vendors } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { enqueueCapabilityJob } from "@/server/jobs";

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
    const accountCodes = [...new Set(suggestions.map((suggestion) => suggestion.suggestedAccountCode))];
    const accountRows = accountCodes.length
      ? await db.select({ code: accounts.code, name: accounts.name }).from(accounts).where(and(eq(accounts.orgId, orgId), inArray(accounts.code, accountCodes)))
      : [];
    const accountNames = new Map(accountRows.map((account) => [account.code, account.name]));
    return NextResponse.json({
      document: {
        id: doc.id,
        title: doc.title,
        status: doc.status,
        sourceType: doc.sourceType,
        parseError: doc.parseError,
        parsedMarkdown: doc.parsedMarkdown,
        rawText: doc.rawText,
        mimeType: doc.mimeType,
        hasSource: Boolean(doc.contentBase64 || doc.rawText),
        refType: doc.refType,
        refId: doc.refId,
        createdAt: doc.createdAt.toISOString(),
      },
      suggestions: suggestions.map((suggestion) => ({
        ...suggestion,
        accountName: accountNames.get(suggestion.suggestedAccountCode) ?? null,
        matchedOn: Array.isArray(suggestion.matchedOn) ? suggestion.matchedOn : [],
      })),
    });
  }

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      sourceType: documents.sourceType,
      refType: documents.refType,
      refId: documents.refId,
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

  const customerList = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(and(eq(customers.orgId, orgId), isNull(customers.deactivatedAt)))
    .orderBy(asc(customers.name))
    .limit(500);

  return NextResponse.json({
    documents: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    vendors: vendorList,
    customers: customerList,
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
    refId?: string;
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
        ...(body.refId ? { refType: "customer", refId: body.refId } : {}),
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
