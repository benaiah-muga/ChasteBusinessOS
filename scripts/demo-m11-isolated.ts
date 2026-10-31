import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { dropFixtureDatabase, provisionFixtureDatabase } from "../packages/db/src/test-fixture";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a loopback port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(origin: string, api: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`Go API exited early with status ${api.exitCode}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still compiling or starting; retry until the deadline.
    }
    await delay(500);
  }
  throw new Error(`Go API did not become healthy at ${origin} within ${timeoutMs}ms`);
}

async function stopApi(api: ChildProcess): Promise<void> {
  if (api.exitCode !== null || api.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => api.once("exit", () => resolve()));
  api.kill("SIGTERM");
  await Promise.race([exited, delay(10_000)]);
  if (api.exitCode === null && api.signalCode === null) api.kill("SIGKILL");
}

const demoArgs = process.argv.slice(2);

function fixtureGoUrl(database: string): string {
  const template = process.env.GO_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!template) {
    throw new Error("The isolated demo needs GO_DATABASE_URL (or DATABASE_URL) to derive the fixture URL");
  }
  const parsed = new URL(template);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function main(): Promise<void> {
  const fixture = await provisionFixtureDatabase({ prefix: "demo_m11" });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const api = spawn("node", ["scripts/dev-api.mjs"], {
    env: {
      ...process.env,
      DATABASE_URL: fixture.url,
      GO_DATABASE_URL: fixtureGoUrl(fixture.database),
      GO_API_ADDR: `127.0.0.1:${port}`,
      GO_API_INTERNAL_URL: origin,
    },
    stdio: "inherit",
  });
  let demoPassed = false;
  try {
    await waitForHealth(origin, api, 180_000);
    const result = spawnSync("pnpm", ["demo:m11", ...demoArgs], {
      env: {
        ...process.env,
        DATABASE_URL: fixture.url,
        CHASTE_GO_API_ORIGIN: origin,
        GO_API_INTERNAL_URL: origin,
      },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`M11 demo exited with status ${result.status ?? "unknown"}`);
    }
    demoPassed = true;
  } finally {
    await stopApi(api);
    await dropFixtureDatabase({ database: fixture.database });
  }

  if (demoPassed) console.log("EXPENSE_M11_DEMO_PASSED");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "M11 isolated demo failed");
  process.exitCode = 1;
});
