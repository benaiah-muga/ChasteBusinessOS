import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, journalEntries, organizations } from "@chaste/db";
import { buildExecutor, buildRegistry } from "@/server/kernel";
import { actorFromResolved } from "@/server/kernel";
import { executeGoCapability } from "@/server/go-bridge";
import { getResolvedUser } from "@/server/session";

const reportCapabilityIDs = [
  "accounting.incomeStatement",
  "accounting.balanceSheet",
  "accounting.cashFlow",
  "accounting.unrealizedFxExposure",
] as const;

type GoReportResult =
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "error"; error: string }
  | { kind: "unavailable" };

async function readGoReport(
  actionContext: NonNullable<ReturnType<typeof actorFromResolved>>,
  session: { userId: string; orgId: string; authSessionId: string },
  capabilityId: (typeof reportCapabilityIDs)[number],
): Promise<GoReportResult> {
  try {
    const result = await executeGoCapability({ actionContext, session, capabilityId, input: {} });
    if (result.kind !== "response") return { kind: "unavailable" };

    const body: unknown = await result.response.json().catch(() => null);
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).safeParse(body);
      return parsed.success ? { kind: "data", data: parsed.data.data } : { kind: "unavailable" };
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      return parsed.success ? { kind: "error", error: parsed.data.error } : { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
  return { kind: "unavailable" };
}

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

  if (process.env.GO_ACCOUNTING_REPORTS_READ === "1") {
    const session = {
      userId: resolved.userId,
      orgId: resolved.orgId,
      authSessionId: resolved.authSessionId,
    };
    const [pnl, balanceSheet, cashFlow, fxExposure] = await Promise.all([
      readGoReport(humanCtx, session, reportCapabilityIDs[0]),
      readGoReport(humanCtx, session, reportCapabilityIDs[1]),
      readGoReport(humanCtx, session, reportCapabilityIDs[2]),
      readGoReport(humanCtx, session, reportCapabilityIDs[3]),
    ]);
    if (
      pnl.kind === "unavailable" || balanceSheet.kind === "unavailable" ||
      cashFlow.kind === "unavailable" || fxExposure.kind === "unavailable"
    ) {
      return NextResponse.json({ error: "Accounting reports service unavailable" }, { status: 503 });
    }
    if (pnl.kind === "error" || balanceSheet.kind === "error") {
      return NextResponse.json(
        { error: pnl.kind === "error" ? pnl.error : balanceSheet.kind === "error" ? balanceSheet.error : "Accounting reports unavailable" },
        { status: 500 },
      );
    }
    return NextResponse.json({
      baseCurrency,
      unsupportedCurrencies: foreignEntries.map((entry) => entry.currency).sort(),
      pnl: pnl.data,
      balanceSheet: balanceSheet.data,
      cashFlow: cashFlow.kind === "data" ? cashFlow.data : null,
      fxExposure: fxExposure.kind === "data" ? fxExposure.data : null,
    }, { headers: { "Cache-Control": "no-store" } });
  }

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
