import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const root = process.cwd();
const manifestPath = join(root, "docs/migration/capabilities.json");
const goCapabilityOverridesPath = join(root, "docs/migration/go-capability-overrides.json");
const censusPath = join(root, "docs/migration/retired-capability-census.json");

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

function readCapabilityCensus(): { capabilities: CapabilityRow[]; warningCount: number } {
  if (!existsSync(censusPath)) {
    throw new Error("docs/migration/retired-capability-census.json is missing.");
  }
  const census = JSON.parse(readFileSync(censusPath, "utf8")) as {
    schemaVersion: number;
    warningCount?: number;
    capabilities: CapabilityRow[];
  };
  if (census.schemaVersion !== 1 || !Array.isArray(census.capabilities)) {
    throw new Error("Retired capability census must use schemaVersion 1 with a capabilities array.");
  }
  return { capabilities: census.capabilities, warningCount: census.warningCount ?? 0 };
}

async function main(): Promise<void> {
  const { capabilities, warningCount } = readCapabilityCensus();

  const overrides = JSON.parse(readFileSync(goCapabilityOverridesPath, "utf8")) as { capabilities: CapabilityRow[] };
  const capabilityByID = new Map(capabilities.map((capability) => [capability.id, capability]));
  for (const capability of overrides.capabilities) capabilityByID.set(capability.id, capability);
  capabilities.splice(0, capabilities.length, ...[...capabilityByID.values()].sort((left, right) => left.id.localeCompare(right.id)));

  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      source: ["docs/migration/retired-capability-census.json", "docs/migration/go-capability-overrides.json"],
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
