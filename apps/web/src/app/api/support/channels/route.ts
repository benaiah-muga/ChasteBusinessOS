import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, supportSettings } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

/**
 * Customer-care channel configuration behind the desk UI. The embed token
 * is lazy-provisioned on first read so setup is zero-step for the user.
 */

function supportEnabled(resolved: { enabledModules?: string[] | null }): boolean {
  return resolved.enabledModules == null || resolved.enabledModules.includes("support");
}

async function loadOrCreate(orgId: string) {
  const db = getDb().db;
  const [row] = await db.select().from(supportSettings).where(eq(supportSettings.orgId, orgId)).limit(1);
  if (row) return row;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const [created] = await db.insert(supportSettings).values({ orgId, embedToken: token }).returning();
  return created!;
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!supportEnabled(resolved)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const settings = await loadOrCreate(resolved.orgId);
  return NextResponse.json({
    autoReplyEnabled: settings!.autoReplyEnabled,
    greeting: settings!.greeting,
    embedToken: settings!.embedToken,
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
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  await loadOrCreate(resolved.orgId);
  const db = getDb().db;
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.autoReplyEnabled !== undefined) update.autoReplyEnabled = parsed.data.autoReplyEnabled;
  if (parsed.data.greeting !== undefined) update.greeting = parsed.data.greeting.trim();
  if (parsed.data.regenerateToken)
    update.embedToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const [updated] = await db
    .update(supportSettings)
    .set(update)
    .where(eq(supportSettings.orgId, resolved.orgId))
    .returning();
  return NextResponse.json({
    autoReplyEnabled: updated!.autoReplyEnabled,
    greeting: updated!.greeting,
    embedToken: updated!.embedToken,
  });
}
