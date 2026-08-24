import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { agentSessions, getDb } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

/**
 * KV-cache / token-efficiency metrics across this org's agent sessions.
 * Cached prompt tokens ÷ input tokens is the hit-rate the context
 * engineering work (stable prefix → org profile → task) optimizes for.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await getDb()
    .db.select({ tokenUsage: agentSessions.tokenUsage, updatedAt: agentSessions.updatedAt })
    .from(agentSessions)
    .where(eq(agentSessions.orgId, resolved.orgId))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(200);

  let input = 0;
  let output = 0;
  let cachedInput = 0;
  let sessionsWithUsage = 0;
  for (const r of rows) {
    const u = r.tokenUsage as { input?: number; output?: number; cachedInput?: number };
    if ((u.input ?? 0) === 0 && (u.output ?? 0) === 0) continue;
    sessionsWithUsage += 1;
    input += u.input ?? 0;
    output += u.output ?? 0;
    cachedInput += u.cachedInput ?? 0;
  }

  const hitRatePct = input > 0 ? Math.round((cachedInput / input) * 100) : null;

  return NextResponse.json({
    totals: {
      sessionsTracked: sessionsWithUsage,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cachedInput,
      cacheHitRatePct: hitRatePct,
    },
    note:
      "cachedInputTokens reflects provider-reported cache reads when available; null hit rate means no usage recorded yet.",
  });
}
