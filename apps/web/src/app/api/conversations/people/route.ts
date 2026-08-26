import { NextResponse } from "next/server";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/** Mentionable targets for the messages composer: org members + the agent. */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("messaging.listPeople", ctx, {});
  if (!result.ok || !result.data) {
    return NextResponse.json({ error: result.error ?? "could not list people" }, { status: 422 });
  }
  return NextResponse.json(result.data);
}
