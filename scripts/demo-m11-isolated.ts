import { spawnSync } from "node:child_process";
import { dropFixtureDatabase, provisionFixtureDatabase } from "../packages/db/src/test-fixture";

async function main(): Promise<void> {
  const fixture = await provisionFixtureDatabase({ prefix: "demo_m11" });
  let demoPassed = false;
  try {
    const result = spawnSync("pnpm", ["demo:m11"], {
      env: { ...process.env, DATABASE_URL: fixture.url },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`M11 demo exited with status ${result.status ?? "unknown"}`);
    }
    demoPassed = true;
  } finally {
    await dropFixtureDatabase({ database: fixture.database });
  }

  if (demoPassed) console.log("EXPENSE_M11_DEMO_PASSED");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "M11 isolated demo failed");
  process.exitCode = 1;
});
