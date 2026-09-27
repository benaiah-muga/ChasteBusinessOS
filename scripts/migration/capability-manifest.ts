import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { getDb } from "@chaste/db";
import type { Capability } from "@chaste/kernel";
import { buildRegistry } from "@/server/kernel";

const root = process.cwd();
const manifestPath = join(root, "docs/migration/capabilities.json");
const unrepresentableTypes = new Set([
  "bigint",
  "symbol",
  "undefined",
  "void",
  "nan",
  "custom",
  "function",
  "transform",
  "pipe",
  "map",
  "set",
]);

function buildRegistryWithoutAdvisoryNoise<T>(operation: () => T): { result: T; warningCount: number } {
  const originalWarn = console.warn;
  let warningCount = 0;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[conformance-warning]")) {
      warningCount += 1;
      return;
    }
    originalWarn(...args);
  };
  try {
    return { result: operation(), warningCount };
  } finally {
    console.warn = originalWarn;
  }
}

function wireSchema(schema: Capability["input"]): object {
  return schema.toJSONSchema({
    target: "draft-7",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      const type = zodSchema._zod.def.type;
      if (type === "date") {
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      } else if (unrepresentableTypes.has(type)) {
        throw new Error(`Unrepresentable Zod type "${type}" in capability wire schema`);
      } else if (type === "literal" && zodSchema._zod.def.values.some((value) => value === undefined || typeof value === "bigint")) {
        throw new Error("Unrepresentable undefined or bigint literal in capability wire schema");
      }
    },
  });
}

async function main(): Promise<void> {
  // Registry composition only captures repositories; it does not query Postgres.
  process.env.DATABASE_URL ??= "postgresql://manifest:manifest@127.0.0.1:5432/manifest";
  const connection = getDb();

  try {
    const { result: registry, warningCount } = buildRegistryWithoutAdvisoryNoise(() => buildRegistry(connection.db));
    const capabilities = registry
      .all()
      .map((capability) => ({
        id: capability.id,
        title: capability.title,
        intent: capability.intent,
        module: capability.module,
        risk: capability.risk,
        permission: capability.permission,
        moneyThresholdMinor: capability.moneyThresholdMinor ?? null,
        inverseCapabilityId: capability.inverse?.capabilityId ?? null,
        inputSchema: wireSchema(capability.input),
        outputSchema: wireSchema(capability.output),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    const manifest = `${JSON.stringify(
      {
        schemaVersion: 1,
        source: "apps/web/src/server/kernel.ts#composeRegistry",
        capabilities,
      },
      null,
      2,
    )}\n`;

    if (process.argv.includes("--check")) {
      if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifest) {
        process.stderr.write("Capability manifest is stale. Run pnpm migration:capabilities:generate.\n");
        process.exitCode = 1;
      }
    } else {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, manifest);
    }

    process.stdout.write(`Capabilities: ${capabilities.length} runtime registrations; ${warningCount} existing conformance warnings.\n`);
  } finally {
    await connection.client.end({ timeout: 1 });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
