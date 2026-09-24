import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), path: z.string().min(1).max(300), intentId: z.string().optional() }),
  z.object({ action: z.literal("rename"), path: z.string().min(1).max(300), newPath: z.string().min(1).max(300), intentId: z.string().optional() }),
  z.object({ action: z.literal("delete"), path: z.string().min(1).max(300), intentId: z.string().optional() }),
]);

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("documents.listFolders", ctx, {});
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json(result.data ?? { folders: [] });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const result = parsed.data.action === "create"
    ? await executor.execute("documents.createFolder", ctx, { path: parsed.data.path })
    : parsed.data.action === "rename"
      ? await executor.execute("documents.renameFolder", ctx, { path: parsed.data.path, newPath: parsed.data.newPath })
      : await executor.execute("documents.deleteFolder", ctx, { path: parsed.data.path });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) return NextResponse.json({ pendingApproval: true }, { status: 202 });
  return NextResponse.json(result.data ?? { ok: true });
}
