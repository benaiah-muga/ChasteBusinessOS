import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Message lifecycle: edit your own, delete your own. Thin route; ownership
 * and tombstone rules live in the capabilities.
 */
const editSchema = z.object({
  body: z.string().min(1).max(8000),
  intentId: z.string().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = editSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("messaging.editMessage", ctx, { messageId: id, body: parsed.data.body });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json({ pendingApproval: true }, { status: 202 });
  }
  return NextResponse.json({ ok: true, data: result.data });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const intentId = new URL(req.url).searchParams.get("intentId") ?? undefined;

  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("messaging.deleteMessage", ctx, { messageId: id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json({ pendingApproval: true }, { status: 202 });
  }
  return NextResponse.json({ ok: true, data: result.data });
}
