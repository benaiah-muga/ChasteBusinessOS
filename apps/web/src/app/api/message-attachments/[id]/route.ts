import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { conversationMembers, getDb, messageAttachments, messages, withOrgContext } from "@chaste/db";
import { missingPermission } from "@/server/route-guards";
import { getResolvedUser } from "@/server/session";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const denied = missingPermission(resolved, "messaging.read");
  if (denied) return denied;
  const { id } = await params;
  const db = getDb().db;
  const [file] = await withOrgContext(db, orgId, async (tx) =>
    await tx
      .select({
        filename: messageAttachments.filename,
        mimeType: messageAttachments.mimeType,
        content: messageAttachments.content,
        messageId: messageAttachments.messageId,
        conversationId: messageAttachments.conversationId,
        uploadedByUserId: messageAttachments.uploadedByUserId,
      })
      .from(messageAttachments)
      .where(and(eq(messageAttachments.id, id), eq(messageAttachments.orgId, orgId)))
      .limit(1),
  );
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (file.messageId === null && file.uploadedByUserId !== resolved.userId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [membership] = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, file.conversationId), eq(conversationMembers.userId, resolved.userId)))
    .limit(1);
  if (!membership) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (file.messageId) {
    const [visibleMessage] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, file.messageId), eq(messages.orgId, orgId), eq(messages.conversationId, file.conversationId), isNull(messages.deletedAt)))
      .limit(1);
    if (!visibleMessage) return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Content-Length": String(file.content.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
