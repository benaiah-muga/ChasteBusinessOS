import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

const client = postgres(url, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
await client.end();
console.log("migrations applied");
