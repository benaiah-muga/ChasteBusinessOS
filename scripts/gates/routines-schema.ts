/**
 * Gate G6: routines schema, RLS, and pg_trgm adoption exist in the live DB.
 */
import { sql } from "drizzle-orm";
import "./env";
import { getDb } from "@chaste/db";

async function scalar(query: ReturnType<typeof sql>): Promise<string | null> {
  const db = getDb().db;
  const result = (await db.execute(query)) as unknown as
    | Record<string, unknown>[]
    | { rows: Record<string, unknown>[] };
  const list = Array.isArray(result) ? result : (result.rows ?? []);
  const row = list[0];
  if (!row) return null;
  return String(Object.values(row)[0]);
}

async function main(): Promise<void> {
  const table = await scalar(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='routines'`,
  );
  if (table !== "routines") throw new Error("routines table missing; run db:migrate");

  const policy = await scalar(sql`SELECT polname FROM pg_policy WHERE polrelid = 'routines'::regclass`);
  if (!policy) throw new Error("routines RLS policy missing");

  const rls = await scalar(sql`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.routines'::regclass`);
  if (rls !== "true") throw new Error("routines RLS not enabled");

  const ext = await scalar(sql`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
  if (ext !== "pg_trgm") throw new Error("pg_trgm extension missing");

  const idx = await scalar(
    sql`SELECT indexname FROM pg_indexes WHERE tablename='memories' AND indexdef LIKE '%gin_trgm_ops%'`,
  );
  if (!idx) throw new Error("memories trigram index missing");

  const soul = await scalar(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name='organizations' AND column_name='agent_soul'`,
  );
  if (soul !== "agent_soul") throw new Error("organizations.agent_soul column missing");

  console.log("[G6] schema OK: routines table + RLS + pg_trgm + trigram index + agent_soul");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
