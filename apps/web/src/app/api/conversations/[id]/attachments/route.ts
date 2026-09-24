import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "choose a file to attach" }, { status: 400 });
  if (file.size === 0 || file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: "attachments must be between 1 byte and 5 MB" }, { status: 413 });
  }
  const filename = z.string().min(1).max(255).safeParse(file.name);
  if (!filename.success) return NextResponse.json({ error: "file name is too long" }, { status: 400 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("messaging.uploadMessageAttachment", ctx, {
    conversationId: id,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
  });
  if (!result.ok || !result.data) return NextResponse.json({ error: result.error ?? "could not upload file" }, { status: 422 });
  const data = result.data as { attachmentId: string };
  return NextResponse.json({ attachmentId: data.attachmentId, filename: file.name, mimeType: file.type, sizeBytes: file.size });
}

export async function DELETE(req: Request, { params }: Params) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await params;
  const raw = await req.json().catch(() => null);
  const parsed = z.object({ attachmentId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("messaging.deletePendingAttachment", ctx, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ ok: true });
}
