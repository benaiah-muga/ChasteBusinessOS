import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@chaste/db";
import { logger } from "@chaste/kernel";

export async function GET() {
  try {
    const { db } = getDb();
    await db.execute(sql`select 1 as ok`);
    return NextResponse.json({
      status: "ok",
      db: "connected",
      time: new Date().toISOString(),
    });
  } catch (err) {
    // Details stay in server logs; this endpoint is anonymous and must not
    // disclose connection strings or topology.
    logger.warn("health check failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ status: "degraded", db: "unavailable" }, { status: 503 });
  }
}

