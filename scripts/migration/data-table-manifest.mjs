import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const root = process.cwd();
const sourcePath = join(root, "packages/db/src/schema/index.ts");
const manifestPath = join(root, "docs/migration/data-tables.json");
const source = readFileSync(sourcePath, "utf8");
const declaration = /export const ([A-Za-z_$][\w$]*)\s*=\s*pgTable\(\s*["']([^"']+)["']/g;
const tables = [];

for (const match of source.matchAll(declaration)) {
  const preceding = source.slice(0, match.index);
  tables.push({
    exportName: match[1],
    tableName: match[2],
    line: preceding.split("\n").length,
  });
}

if (tables.length === 0) throw new Error(`No exported Drizzle tables found in ${sourcePath}`);
if (new Set(tables.map((table) => table.exportName)).size !== tables.length) {
  throw new Error("Duplicate Drizzle table export name detected");
}
if (new Set(tables.map((table) => table.tableName)).size !== tables.length) {
  throw new Error("Duplicate Drizzle database table name detected");
}

const manifest = `${JSON.stringify(
  {
    schemaVersion: 1,
    source: "packages/db/src/schema/index.ts",
    tableCount: tables.length,
    tables,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifest) {
    process.stderr.write("Data table manifest is stale. Run pnpm migration:data:generate.\n");
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifest);
}

process.stdout.write(`Data tables: ${tables.length} exported Drizzle tables.\n`);
