import { NextResponse } from "next/server";
import { recentLedgerEvents } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { getDb } from "@chaste/db";

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "accounting.read");
  if (denied) return denied;
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? 60);
  const limit = Number.isFinite(raw) ? Math.floor(Math.max(1, Math.min(raw, 200))) : 60;
  const events = await recentLedgerEvents(resolved.orgId, getDb().db, limit);
  return NextResponse.json({ events });
}
