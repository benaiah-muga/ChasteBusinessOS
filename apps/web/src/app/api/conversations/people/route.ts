import { NextResponse } from "next/server";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/** Mentionable targets for the messages composer: org members + the agent. */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const query = new URL(req.url).searchParams.get("q")?.trim();
  const result = await executor.execute("messaging.listPeople", ctx, {
    ...(query ? { query } : {}),
    limit: query ? 30 : 100,
  });
  if (!result.ok || !result.data) {
    return NextResponse.json({ error: result.error ?? "could not list people" }, { status: 422 });
  }
  return NextResponse.json(result.data);
}
