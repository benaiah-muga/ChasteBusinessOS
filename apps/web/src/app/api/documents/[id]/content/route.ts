import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { documents, getDb } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const [document] = await getDb().db
    .select({
      title: documents.title,
      mimeType: documents.mimeType,
      contentBase64: documents.contentBase64,
      rawText: documents.rawText,
    })
    .from(documents)
    .where(and(eq(documents.orgId, resolved.orgId), eq(documents.id, id)))
    .limit(1);
  if (!document) return NextResponse.json({ error: "not found" }, { status: 404 });

  const filename = encodeURIComponent(document.title.replace(/[\r\n]/g, " "));
  const headers = new Headers({
    "Content-Disposition": `inline; filename*=UTF-8''${filename}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (document.contentBase64 && document.mimeType) {
    const mimeType = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"].includes(document.mimeType)
      ? document.mimeType
      : "application/octet-stream";
    headers.set("Content-Type", mimeType);
    return new Response(Uint8Array.from(Buffer.from(document.contentBase64, "base64")), { headers });
  }
  if (document.rawText) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(document.rawText, { headers });
  }
  return NextResponse.json({ error: "source unavailable" }, { status: 404 });
}
