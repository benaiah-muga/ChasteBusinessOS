import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(connectionStringOrConfig: string | postgres.Options<Record<string, postgres.PostgresType>>) {
  const client =
    typeof connectionStringOrConfig === "string"
      ? postgres(connectionStringOrConfig, { max: 10 })
      : postgres({ max: 10, ...connectionStringOrConfig });
  return drizzle(client, { schema });
}
