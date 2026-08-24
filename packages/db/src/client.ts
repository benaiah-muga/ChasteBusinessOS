import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema/index";

export type Database = ReturnType<typeof createDb>;

/** The transaction handle drizzle passes into db.transaction callbacks. */
export type Tx = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

export function createDb(url: string) {
  const client = postgres(url, {
    prepare: false,
    // Bounded pool: unbounded defaults let parallel routes exhaust
    // max_connections under load.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return { db: drizzle(client, { schema }), client };
}

// Next dev hot-reloads every module; a module-scoped singleton would open a
// fresh pool per recompile until Postgres refuses connections. Cache on
// globalThis so reloads reuse one pool.
const globalStore = globalThis as unknown as { __chasteDb?: ReturnType<typeof createDb> };

export function getDb() {
  if (!globalStore.__chasteDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalStore.__chasteDb = createDb(url);
  }
  return globalStore.__chasteDb;
}

export { schema };

/**
 * Runs `fn` inside a transaction whose `app.org_id` is set, so Postgres RLS
 * policies (migration 0014) scope every row read and write to one tenant.
 * SET LOCAL is transaction-scoped: the setting cannot leak back into the pool.
 * When connected as a role that bypasses RLS (owner/superuser) this is still
 * correct, it merely becomes a no-op defense layer.
 */
export async function withOrgContext<T>(
  db: Database["db"],
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
