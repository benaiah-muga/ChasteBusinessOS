import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { agentSessions, getDb } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { pushSteering } from "@/server/steering";

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(8000),
});

/**
 * Mid-run steering: accepts an additional user message for a session the
 * caller owns while that session's agent loop is running. Ownership is
 * enforced like /api/chat so steering can never inject into another user's
 * trajectory.
 */
export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const [owned] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, parsed.data.sessionId),
        eq(agentSessions.orgId, resolved.orgId),
        eq(agentSessions.userId, resolved.userId),
      ),
    )
    .limit(1);
  if (!owned) return NextResponse.json({ error: "session not found" }, { status: 404 });

  pushSteering(parsed.data.sessionId, parsed.data.message);
  return NextResponse.json({ queued: true });
}
