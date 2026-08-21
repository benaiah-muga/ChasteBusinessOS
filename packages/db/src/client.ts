import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export type Database = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const client = postgres(url, { prepare: false });
  return { db: drizzle(client, { schema }), client };
}

let singleton: ReturnType<typeof createDb> | undefined;

export function getDb() {
  if (!singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    singleton = createDb(url);
  }
  return singleton;
}

export { schema };
