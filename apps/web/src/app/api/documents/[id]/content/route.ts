import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { documents, getDb } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { createDbModuleGate } from "@/server/kernel";

const safeInlineTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp", "text/plain"]);

export function documentContentHeaders(mimeType: string, title: string): Headers {
  const normalizedType = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const inline = safeInlineTypes.has(normalizedType);
  const filename = title.replace(/[^a-z0-9._-]+/gi, "-") || "document";
  return new Headers({
    "Content-Type": inline ? normalizedType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  if (!(await createDbModuleGate(db).isEnabled(resolved.orgId, "documents"))) {
    return NextResponse.json({ error: "documents module is disabled" }, { status: 403 });
  }

  const { id } = await params;
  const [document] = await db
    .select({ mimeType: documents.mimeType, contentBase64: documents.contentBase64, title: documents.title })
    .from(documents)
    .where(and(eq(documents.orgId, resolved.orgId), eq(documents.id, id)))
    .limit(1);

  if (!document) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!document.contentBase64 || !document.mimeType) return NextResponse.json({ error: "document has no uploaded file" }, { status: 404 });

  return new Response(Buffer.from(document.contentBase64, "base64"), {
    headers: documentContentHeaders(document.mimeType, document.title),
  });
}
