import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { getDb, journalEntries, organizations } from "@chaste/db";
import { buildExecutor, buildRegistry } from "@/server/kernel";
import { actorFromResolved } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb().db;
  const [org] = await db.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, resolved.orgId)).limit(1);
  const baseCurrency = org?.baseCurrency ?? "USD";
  const foreignEntries = await db
    .selectDistinct({ currency: journalEntries.currency })
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, resolved.orgId), sql`${journalEntries.currency} <> ${baseCurrency}`));
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // Reports are read capabilities, the agent answers from these too.
  const pnl = await executor.execute("accounting.incomeStatement", humanCtx, {});
  const bs = await executor.execute("accounting.balanceSheet", humanCtx, {});
  if (!pnl.ok || !bs.ok) {
    return NextResponse.json({ error: pnl.error ?? bs.error }, { status: 500 });
  }
  const cashFlow = await executor.execute("accounting.cashFlow", humanCtx, {});
  const fxExposure = await executor.execute("accounting.unrealizedFxExposure", humanCtx, {});
  return NextResponse.json({
    baseCurrency,
    unsupportedCurrencies: foreignEntries.map((entry) => entry.currency).sort(),
    pnl: pnl.data,
    balanceSheet: bs.data,
    cashFlow: cashFlow.ok ? cashFlow.data : null,
    fxExposure: fxExposure.ok ? fxExposure.data : null,
  });
}
