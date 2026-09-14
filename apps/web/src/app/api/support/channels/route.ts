import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, supportSettings } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Customer-care channel configuration (N08). Reading must never mutate and
 * never hand the embed credential to someone who cannot manage it: GET is a
 * pure read (token only for iam.admin), POST provisions or changes settings
 * and requires iam.admin — changing auto-reply or rotating the token changes
 * what the public website can reach.
 */

function supportEnabled(resolved: { enabledModules?: string[] | null }): boolean {
  return resolved.enabledModules == null || resolved.enabledModules.includes("support");
}

function newEmbedToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!supportEnabled(resolved)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const isAdmin = hasPermission({ permissions: resolved.permissions }, "iam.admin");
  const [settings] = await getDb()
    .db.select()
    .from(supportSettings)
    .where(eq(supportSettings.orgId, resolved.orgId))
    .limit(1);
  if (!settings) {
    // No side effects on read: an unconfigured channel reads as defaults,
    // and the embed credential simply does not exist until an admin saves.
    return NextResponse.json({ autoReplyEnabled: false, greeting: "", embedToken: null, canManage: isAdmin });
  }
  return NextResponse.json({
    autoReplyEnabled: settings.autoReplyEnabled,
    greeting: settings.greeting,
    embedToken: isAdmin ? settings.embedToken : null,
    canManage: isAdmin,
  });
}

const patchSchema = z.object({
  autoReplyEnabled: z.boolean().optional(),
  greeting: z.string().min(1).max(300).optional(),
  regenerateToken: z.boolean().optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!supportEnabled(resolved)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!hasPermission({ permissions: resolved.permissions }, "iam.admin")) {
    return NextResponse.json({ error: "forbidden: missing iam.admin" }, { status: 403 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.autoReplyEnabled !== undefined) update.autoReplyEnabled = parsed.data.autoReplyEnabled;
  if (parsed.data.greeting !== undefined) update.greeting = parsed.data.greeting.trim();
  if (parsed.data.regenerateToken)
    update.embedToken = newEmbedToken();

  const [updated] = await db
    .update(supportSettings)
    .set(update)
    .where(eq(supportSettings.orgId, resolved.orgId))
    .returning();
  if (updated) {
    return NextResponse.json({
      autoReplyEnabled: updated.autoReplyEnabled,
      greeting: updated.greeting,
      embedToken: updated.embedToken,
      canManage: true,
    });
  }
  // First save provisions the channel and its embed credential.
  const [created] = await db
    .insert(supportSettings)
    .values({
      orgId: resolved.orgId,
      embedToken: newEmbedToken(),
      ...(parsed.data.autoReplyEnabled !== undefined ? { autoReplyEnabled: parsed.data.autoReplyEnabled } : {}),
      ...(parsed.data.greeting !== undefined ? { greeting: parsed.data.greeting.trim() } : {}),
    })
    .returning();
  return NextResponse.json({
    autoReplyEnabled: created!.autoReplyEnabled,
    greeting: created!.greeting,
    embedToken: created!.embedToken,
    canManage: true,
  });
}
