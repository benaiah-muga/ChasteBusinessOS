import { NextResponse } from "next/server";
import { recentLedgerEvents } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { getDb } from "@chaste/db";

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 60), 200);
  const events = await recentLedgerEvents(resolved.orgId, getDb().db, limit);
  return NextResponse.json({ events });
}
