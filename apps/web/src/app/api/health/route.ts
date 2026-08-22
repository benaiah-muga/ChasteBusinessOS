import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@chaste/db";

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
    return NextResponse.json(
      { status: "degraded", error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
