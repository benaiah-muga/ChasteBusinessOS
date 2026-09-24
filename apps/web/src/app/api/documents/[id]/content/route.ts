import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { documents, getDb } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const [document] = await getDb().db
    .select({ mimeType: documents.mimeType, contentBase64: documents.contentBase64, title: documents.title })
    .from(documents)
    .where(and(eq(documents.orgId, resolved.orgId), eq(documents.id, id)))
    .limit(1);

  if (!document) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!document.contentBase64 || !document.mimeType) return NextResponse.json({ error: "document has no uploaded file" }, { status: 404 });

  return new Response(Buffer.from(document.contentBase64, "base64"), {
    headers: {
      "Content-Type": document.mimeType,
      "Content-Disposition": `inline; filename="${document.title.replace(/[^a-z0-9._-]+/gi, "-")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
