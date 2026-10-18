import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Capability } from "@chaste/kernel";

const root = process.cwd();
const manifestPath = join(root, "docs/migration/capabilities.json");
const goCapabilityOverridesPath = join(root, "docs/migration/go-capability-overrides.json");
const legacyKernelPath = join(root, "apps/web/src/server/kernel.ts");
const censusPath = join(root, "docs/migration/retired-capability-census.json");
const freezeCensus = process.argv.includes("--freeze-census");
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

type CapabilityRow = {
  id: string;
  title: string;
  intent: string;
  module: string;
  risk: string;
  permission: string;
  executionScope: string;
  moneyThresholdMinor: number | null;
  inverseCapabilityId: string | null;
  inputSchema: object;
  outputSchema: object;
};

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

function capabilityRow(capability: Capability): CapabilityRow {
  return {
    id: capability.id,
    title: capability.title,
    intent: capability.intent,
    module: capability.module,
    risk: capability.risk,
    permission: capability.permission,
    executionScope: capability.executionScope ?? "organization",
    moneyThresholdMinor: capability.moneyThresholdMinor ?? null,
    inverseCapabilityId: capability.inverse?.capabilityId ?? null,
    inputSchema: wireSchema(capability.input),
    outputSchema: wireSchema(capability.output),
  };
}

async function captureLegacyCapabilities(): Promise<{ capabilities: CapabilityRow[]; warningCount: number }> {
  // Registry composition only captures repositories; it does not query Postgres.
  process.env.DATABASE_URL ??= "postgresql://manifest:manifest@127.0.0.1:5432/manifest";
  const { getDb } = await import("@chaste/db");
  const { buildRegistry } = (await import(pathToFileURL(legacyKernelPath).href)) as {
    buildRegistry(db: unknown): { all(): Capability[] };
  };
  const connection = getDb();
  try {
    const { result: registry, warningCount } = buildRegistryWithoutAdvisoryNoise(() => buildRegistry(connection.db));
    const capabilities = registry
      .all()
      .map(capabilityRow)
      .sort((left, right) => left.id.localeCompare(right.id));
    return { capabilities, warningCount };
  } finally {
    await connection.client.end({ timeout: 1 });
  }
}

async function main(): Promise<void> {
  let capabilities: CapabilityRow[];
  let warningCount: number;
  if (existsSync(legacyKernelPath) && !process.argv.includes("--frozen")) {
    ({ capabilities, warningCount } = await captureLegacyCapabilities());
    if (freezeCensus) {
      writeFileSync(
        censusPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            capturedFrom: "apps/web/src/server/kernel.ts#composeRegistry",
            warningCount,
            capabilities,
          },
          null,
          2,
        )}\n`,
      );
    }
  } else {
    if (!existsSync(censusPath)) {
      throw new Error("apps/web/src/server/kernel.ts is retired and docs/migration/retired-capability-census.json is missing.");
    }
    const census = JSON.parse(readFileSync(censusPath, "utf8")) as {
      schemaVersion: number;
      warningCount?: number;
      capabilities: CapabilityRow[];
    };
    if (census.schemaVersion !== 1 || !Array.isArray(census.capabilities)) {
      throw new Error("Retired capability census must use schemaVersion 1 with a capabilities array.");
    }
    capabilities = census.capabilities;
    warningCount = census.warningCount ?? 0;
  }

  const overrides = JSON.parse(readFileSync(goCapabilityOverridesPath, "utf8")) as { capabilities: CapabilityRow[] };
  const capabilityByID = new Map(capabilities.map((capability) => [capability.id, capability]));
  for (const capability of overrides.capabilities) capabilityByID.set(capability.id, capability);
  capabilities.splice(0, capabilities.length, ...[...capabilityByID.values()].sort((left, right) => left.id.localeCompare(right.id)));

  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      source: ["apps/web/src/server/kernel.ts#composeRegistry", "docs/migration/go-capability-overrides.json"],
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
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
