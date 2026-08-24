import { NextResponse } from "next/server";
import { getDb } from "@chaste/db";
import { buildExecutor, buildRegistry } from "@/server/kernel";
import { actorFromResolved } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const registry = buildRegistry(getDb().db);
  const executor = buildExecutor(getDb().db, registry);

  // Reports are read capabilities, the agent answers from these too.
  const pnl = await executor.execute("accounting.incomeStatement", humanCtx, {});
  const bs = await executor.execute("accounting.balanceSheet", humanCtx, {});
  if (!pnl.ok || !bs.ok) {
    return NextResponse.json({ error: pnl.error ?? bs.error }, { status: 500 });
  }
  return NextResponse.json({ pnl: pnl.data, balanceSheet: bs.data });
}
