import { NextResponse } from "next/server";
import { getDb } from "@chaste/db";
import { triggerRoutineByWebhookToken } from "@/server/routines";
import { logger } from "@chaste/kernel";

/**
 * Paperclip-compatible trigger endpoint: any external orchestrator (or a
 * cron, or a curl) can fire a routine run by POSTing here with the
 * routine's secret webhook token. No session auth by design; the 128 bits
 * of token entropy are the capability. Rate-limit: the queue's maxAttempts
 * plus worker pacing bound runaway callers.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb().db;
  const result = await triggerRoutineByWebhookToken(db, token);
  if (!result.ok) {
    logger.warn("routine webhook rejected", { reason: result.error });
    return NextResponse.json({ error: result.error }, { status: 404 });
  }
  return NextResponse.json({ accepted: true }, { status: 202 });
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return POST(req, { params });
}
