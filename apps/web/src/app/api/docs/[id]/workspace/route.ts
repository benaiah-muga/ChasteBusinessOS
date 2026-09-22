import { NextResponse } from "next/server";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { docDrafts, docPresence, getDb, withOrgContext } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

/**
 * Draft workspace state for one document: keystroke autosave, presence
 * heartbeat and the soft editing lock. Written DIRECTLY under RLS, outside
 * the ledger and outside governance, on purpose (ADR 0056): autosave noise
 * must not flood the hash chain, and losing a draft loses at most the
 * unsaved tail of a typing session. Publishing still rides the governed
 * documents.saveDocVersion capability.
 *
 * One POST is the editor's whole tick: heartbeat me, optionally save my
 * draft, then tell me who else is here and whose pen it is.
 */

const LOCK_SECONDS = 30;
const PRESENCE_WINDOW_SECONDS = 15;

const bodySchema = z.object({
  content: z.record(z.string(), z.unknown()).optional(),
  /** Client's known draft revision; mismatch means another writer advanced. */
  rev: z.number().int().min(1).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const displayName = resolved.name || resolved.email.split("@")[0]!;
  const me = resolved.userId;
  const lockUntil = new Date(Date.now() + LOCK_SECONDS * 1000);

  return withOrgContext(getDb().db, resolved.orgId, async (tx) => {
    // Heartbeat presence.
    await tx
      .insert(docPresence)
      .values({ orgId: resolved.orgId!, documentId: id, userId: me, displayName, seenAt: new Date() })
      .onConflictDoUpdate({
        target: [docPresence.documentId, docPresence.userId],
        set: { displayName, seenAt: new Date() },
      });

    // Soft lock: take or renew mine (only a real draft row carries a lock).
    const [draft] = await tx.select().from(docDrafts).where(eq(docDrafts.documentId, id)).limit(1);
    const lockFresh = draft?.lockUntil && draft.lockUntil.getTime() > Date.now();
    const lockHeldByOther = Boolean(draft && lockFresh && draft.lockedByUserId && draft.lockedByUserId !== me);

    if (lockHeldByOther) {
      return NextResponse.json({
        lock: { heldBy: draft!.lockedByName ?? "someone else", mine: false },
        others: await others(tx, id, me),
      });
    }

    // Autosave (advisory rev check; server owns the counter). Only real
    // content creates a draft row - a presence heartbeat must not fabricate
    // an empty draft that would shadow the published content in the editor.
    let savedRev: number | undefined;
    if (parsed.data.content) {
      if (draft) {
        if (parsed.data.rev !== undefined && parsed.data.rev !== draft.rev) {
          return NextResponse.json(
            {
              conflict: true,
              draft: { content: draft.contentJson, rev: draft.rev, updatedAt: draft.updatedAt.toISOString() },
              lock: { heldBy: displayName, mine: true },
              others: await others(tx, id, me),
            },
            { status: 409 },
          );
        }
        const [saved] = await tx
          .update(docDrafts)
          .set({
            contentJson: parsed.data.content,
            rev: sql`${docDrafts.rev} + 1`,
            lockedByUserId: me,
            lockedByName: displayName,
            lockUntil,
            updatedAt: new Date(),
          })
          .where(eq(docDrafts.id, draft.id))
          .returning({ rev: docDrafts.rev });
        savedRev = saved!.rev;
      } else {
        const [saved] = await tx
          .insert(docDrafts)
          .values({
            orgId: resolved.orgId!,
            documentId: id,
            contentJson: parsed.data.content,
            lockedByUserId: me,
            lockedByName: displayName,
            lockUntil,
          })
          .returning({ rev: docDrafts.rev });
        savedRev = saved!.rev;
      }
    } else if (draft) {
      // Heartbeat-only: renew my hold on the pen, or take an expired one.
      await tx
        .update(docDrafts)
        .set({ lockedByUserId: me, lockedByName: displayName, lockUntil })
        .where(eq(docDrafts.id, draft.id));
    }

    const [fresh] = await tx.select().from(docDrafts).where(eq(docDrafts.documentId, id)).limit(1);

    return NextResponse.json({
      lock: { heldBy: displayName, mine: true },
      savedRev,
      draft: fresh ? { content: fresh.contentJson, rev: fresh.rev, updatedAt: fresh.updatedAt.toISOString() } : null,
      others: await others(tx, id, me),
    });
  });
}

/** Release my presence and lock (editor unmount). Never fails hard. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  return withOrgContext(getDb().db, resolved.orgId, async (tx) => {
    await tx.delete(docPresence).where(and(eq(docPresence.documentId, id), eq(docPresence.userId, resolved.userId)));
    await tx
      .update(docDrafts)
      .set({ lockedByUserId: null, lockedByName: null, lockUntil: null })
      .where(and(eq(docDrafts.documentId, id), eq(docDrafts.lockedByUserId, resolved.userId)));
    return NextResponse.json({ ok: true });
  });
}

async function others(
  tx: Parameters<Parameters<typeof withOrgContext>[2]>[0],
  documentId: string,
  me: string,
): Promise<{ userId: string; name: string }[]> {
  const since = new Date(Date.now() - PRESENCE_WINDOW_SECONDS * 1000);
  const rows = await tx
    .select({ userId: docPresence.userId, name: docPresence.displayName })
    .from(docPresence)
    .where(and(eq(docPresence.documentId, documentId), ne(docPresence.userId, me), gt(docPresence.seenAt, since)));
  return rows;
}
