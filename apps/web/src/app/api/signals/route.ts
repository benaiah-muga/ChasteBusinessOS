import { NextResponse } from "next/server";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/** The needs-attention feed: every module's signals, red first, advisory only. */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const severity = new URL(req.url).searchParams.get("severity") ?? undefined;
  const module = new URL(req.url).searchParams.get("module") ?? undefined;
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const run = await executor.execute("signals.list", ctx, { severity, module });
  if (!run.ok) return NextResponse.json({ error: run.error }, { status: 500 });
  const data = run.data as { signals?: unknown[] } | undefined;
  return NextResponse.json({ signals: data?.signals ?? [] });
}
