import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { buildExecutor, buildRegistry } from "@/server/kernel";
import { actorFromResolved } from "@/server/kernel";
import { executeGoCapability } from "@/server/go-bridge";
import { getResolvedUser } from "@/server/session";

const reportCapabilityIDs = [
  "accounting.incomeStatement",
  "accounting.balanceSheet",
  "accounting.cashFlow",
  "accounting.unrealizedFxExposure",
  "accounting.reportCurrencyMetadata",
] as const;

const reportCurrencyMetadataSchema = z.object({
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  unsupportedCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
}).strict().refine((metadata) => {
  const sorted = [...metadata.unsupportedCurrencies].sort();
  return metadata.unsupportedCurrencies.every((currency) => currency !== metadata.baseCurrency) &&
    new Set(metadata.unsupportedCurrencies).size === metadata.unsupportedCurrencies.length &&
    metadata.unsupportedCurrencies.every((currency, index) => currency === sorted[index]);
});

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

  if (process.env.GO_ACCOUNTING_REPORTS_READ === "1") {
    const session = {
      userId: resolved.userId,
      orgId: resolved.orgId,
      authSessionId: resolved.authSessionId,
    };
    const [pnl, balanceSheet, cashFlow, fxExposure, currencyMetadataResult] = await Promise.all([
      readGoReport(humanCtx, session, reportCapabilityIDs[0]),
      readGoReport(humanCtx, session, reportCapabilityIDs[1]),
      readGoReport(humanCtx, session, reportCapabilityIDs[2]),
      readGoReport(humanCtx, session, reportCapabilityIDs[3]),
      readGoReport(humanCtx, session, reportCapabilityIDs[4]),
    ]);
    if (
      pnl.kind === "unavailable" || balanceSheet.kind === "unavailable" ||
      cashFlow.kind === "unavailable" || fxExposure.kind === "unavailable" ||
      currencyMetadataResult.kind === "unavailable"
    ) {
      return NextResponse.json({ error: "Accounting reports service unavailable" }, { status: 503 });
    }
    if (pnl.kind === "error" || balanceSheet.kind === "error") {
      return NextResponse.json(
        { error: pnl.kind === "error" ? pnl.error : balanceSheet.kind === "error" ? balanceSheet.error : "Accounting reports unavailable" },
        { status: 500 },
      );
    }
    if (currencyMetadataResult.kind === "error") {
      return NextResponse.json({ error: currencyMetadataResult.error }, { status: 500 });
    }
    const currencyMetadata = reportCurrencyMetadataSchema.safeParse(currencyMetadataResult.data);
    if (!currencyMetadata.success) {
      return NextResponse.json({ error: "Accounting reports service unavailable" }, { status: 503 });
    }
    return NextResponse.json({
      baseCurrency: currencyMetadata.data.baseCurrency,
      unsupportedCurrencies: currencyMetadata.data.unsupportedCurrencies,
      pnl: pnl.data,
      balanceSheet: balanceSheet.data,
      cashFlow: cashFlow.kind === "data" ? cashFlow.data : null,
      fxExposure: fxExposure.kind === "data" ? fxExposure.data : null,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // Reports are read capabilities, the agent answers from these too.
  const currencyMetadata = await executor.execute("accounting.reportCurrencyMetadata", humanCtx, {});
  const pnl = await executor.execute("accounting.incomeStatement", humanCtx, {});
  const bs = await executor.execute("accounting.balanceSheet", humanCtx, {});
  if (!currencyMetadata.ok || !pnl.ok || !bs.ok) {
    return NextResponse.json({ error: currencyMetadata.error ?? pnl.error ?? bs.error }, { status: 500 });
  }
  const parsedCurrencyMetadata = reportCurrencyMetadataSchema.safeParse(currencyMetadata.data);
  if (!parsedCurrencyMetadata.success) {
    return NextResponse.json({ error: "Accounting report currency metadata is invalid" }, { status: 500 });
  }
  const cashFlow = await executor.execute("accounting.cashFlow", humanCtx, {});
  const fxExposure = await executor.execute("accounting.unrealizedFxExposure", humanCtx, {});
  return NextResponse.json({
    baseCurrency: parsedCurrencyMetadata.data.baseCurrency,
    unsupportedCurrencies: parsedCurrencyMetadata.data.unsupportedCurrencies,
    pnl: pnl.data,
    balanceSheet: bs.data,
    cashFlow: cashFlow.ok ? cashFlow.data : null,
    fxExposure: fxExposure.ok ? fxExposure.data : null,
  });
}
