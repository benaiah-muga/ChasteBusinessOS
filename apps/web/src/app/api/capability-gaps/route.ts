import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb, tickets } from "@chaste/db";
import { hasPermission } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission({ permissions: resolved.permissions }, "platform.creator")) {
    return NextResponse.json({ error: "requires platform.creator permission" }, { status: 403 });
  }

  const rows = await getDb()
    .db.select()
    .from(tickets)
    .where(and(eq(tickets.orgId, resolved.orgId), eq(tickets.origin, "capability_gap")))
    .orderBy(desc(tickets.createdAt))
    .limit(100);
  return NextResponse.json({
    gaps: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  });
}
