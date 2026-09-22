import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, memories } from "@chaste/db";import { actorFromResolved, buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Org memory manager: read is open to members (it is the org's own
 * knowledge base); deletion is governed (documents.deleteOrgMemory,
 * destructive-class) so the workmate proposing a wipe waits for a person.
 * Embeddings never leave the server - the listing carries content previews.
 */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const kind = new URL(req.url).searchParams.get("kind") ?? "";

  const rows = await getDb()
    .db
    .select({
      id: memories.id,
      kind: memories.kind,
      source: memories.source,
      content: memories.content,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(eq(memories.orgId, resolved.orgId)))
    .orderBy(desc(memories.createdAt))
    .limit(200);

  const filtered = rows
    .filter((r) => (kind ? r.kind === kind : true))
    .filter((r) => (q ? r.content.toLowerCase().includes(q) || (r.source ?? "").toLowerCase().includes(q) : true))
    .map((r) => ({
      ...r,
      preview: r.content.slice(0, 240),
      createdAt: r.createdAt.toISOString(),
    }));
  return NextResponse.json({
    memories: filtered,
    total: rows.length,
    canEdit: hasPermissionFor({ permissions: resolved.permissions }, "documents.write"),
  });
}

const bodySchema = z.object({
  action: z.literal("delete"),
  memoryId: z.string().uuid(),
  intentId: z.string().optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("documents.deleteOrgMemory", ctx, { memoryId: parsed.data.memoryId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "Memory deletion proposed by the workmate waits for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
