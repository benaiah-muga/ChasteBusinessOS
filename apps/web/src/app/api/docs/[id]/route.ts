import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * One authored document: full read (content + version history) for the
 * editor, plus publish, restore and delete. Thin route - auth plus
 * dispatch; every rule lives in the capability.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const version = new URL(req.url).searchParams.get("version");
  if (version) {
    const one = await executor.execute("documents.getDocVersion", ctx, { documentId: id, version: Number(version) });
    if (!one.ok) return NextResponse.json({ error: one.error }, { status: 404 });
    const v = (one.data ?? {}) as { version?: number; html?: string; note?: string | null; createdAt?: string };
    return NextResponse.json({ version: v.version ?? Number(version), html: v.html ?? "", note: v.note, createdAt: v.createdAt });
  }

  const doc = await executor.execute("documents.getDoc", ctx, { documentId: id });
  if (!doc.ok) return NextResponse.json({ error: doc.error }, { status: doc.error === "document not found" ? 404 : 422 });
  const versions = await executor.execute("documents.listDocVersions", ctx, { documentId: id });
  const payload = (doc.data ?? {}) as { document?: unknown };
  const versionRows = (versions.ok ? versions.data : {}) as { versions?: unknown[] } | undefined;
  return NextResponse.json({
    document: payload.document ?? null,
    versions: versionRows?.versions ?? [],
  });
}

const contentSchema = z.record(z.string(), z.unknown());

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("publish"),
    title: z.string().min(1).max(200).optional(),
    content: contentSchema,
    html: z.string().max(2_000_000),
    note: z.string().max(500).optional(),
    pageSettings: z.object({ size: z.enum(["A4", "Letter"]), orientation: z.enum(["portrait", "landscape"]), margin: z.enum(["compact", "normal", "wide"]) }).optional(),
    intentId: z.string().optional(),
  }),
  z.object({
    action: z.literal("restore"),
    sourceVersion: z.number().int().min(1),
    note: z.string().max(500).optional(),
    intentId: z.string().optional(),
  }),
  z.object({ action: z.literal("delete"), intentId: z.string().optional() }),
  z.object({
    action: z.literal("updateMetadata"),
    title: z.string().min(1).max(200).optional(),
    folder: z.string().max(300).nullable().optional(),
    linkedRecordType: z.string().max(60).nullable().optional(),
    linkedRecordId: z.string().uuid().nullable().optional(),
    linkedRecordLabel: z.string().max(240).nullable().optional(),
    intentId: z.string().optional(),
  }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const result = await (async () => {
    switch (parsed.data.action) {
      case "publish":
        return executor.execute("documents.saveDocVersion", ctx, {
          documentId: id,
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          content: parsed.data.content,
          html: parsed.data.html,
          ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
          ...(parsed.data.pageSettings !== undefined ? { pageSettings: parsed.data.pageSettings } : {}),
        });
      case "restore":
        return executor.execute("documents.restoreDocVersion", ctx, {
          documentId: id,
          sourceVersion: parsed.data.sourceVersion,
          ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        });
      case "delete":
        return executor.execute("documents.deleteDoc", ctx, { documentId: id });
      case "updateMetadata":
        return executor.execute("documents.updateDocMetadata", ctx, { documentId: id, ...parsed.data });
    }
  })();

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json(result.data ?? { ok: true });
}
