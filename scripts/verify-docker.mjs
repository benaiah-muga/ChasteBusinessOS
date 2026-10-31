/* global console, fetch, process, setTimeout */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = "chaste-docker-verification";
const webPort = "3300";
const apiPort = "38080";
const dbPort = "55433";
const composeEnv = {
  ...process.env,
  BETTER_AUTH_SECRET: "docker-verification-only-secret-32-bytes",
  GO_INTERNAL_AUTH_SECRET: "docker-verification-only-internal-secret-32-bytes",
  CHASTE_WEB_PORT: webPort,
  CHASTE_API_PORT: apiPort,
  CHASTE_DB_PORT: dbPort,
  GO_PUBLIC_APP_URL: `http://localhost:${webPort}`,
  GO_AUTH_PUBLIC_ORIGIN: `http://localhost:${webPort}`,
  GO_AUTH_MODE: "development",
  // The API constructs its optional NVIDIA embedder during startup. This
  // syntax-valid test key keeps runtime wiring testable without making a call.
  NVIDIA_API_KEY: "nvapi-docker-verification-key",
  CHASTE_STRICT_MIGRATION_BACKUP: "1",
  COMPOSE_PROJECT_NAME: project,
};
const composeArgs = ["compose", "-p", project];

function compose(...args) {
  execFileSync("docker", [...composeArgs, ...args], {
    cwd: process.cwd(),
    env: composeEnv,
    stdio: "inherit",
  });
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${webPort}/api/health`;
  const deadline = Date.now() + 180_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.status === 200 && body.status === "ok" && body.db === "connected") return;
      lastError = `HTTP ${response.status}: ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Docker Vite/Go health check timed out: ${lastError}`);
}

function migrationSnapshotHashes() {
  const container = execFileSync("docker", [...composeArgs, "ps", "-a", "-q", "migrate-schema"], {
    cwd: process.cwd(),
    env: composeEnv,
    encoding: "utf8",
  }).trim();
  if (!container) throw new Error("Compose migration service container was not retained for inspection");
  const destination = mkdtempSync(join(tmpdir(), "chaste-migration-backup-"));
  try {
    execFileSync("docker", ["cp", `${container}:/repo/packages/db/backups`, destination], {
      cwd: process.cwd(),
      env: composeEnv,
      stdio: "inherit",
    });
    const backupDirectory = join(destination, "backups");
    const snapshots = readdirSync(backupDirectory)
      .filter((file) => statSync(join(backupDirectory, file)).size > 0)
      .map((file) => createHash("sha256").update(readFileSync(join(backupDirectory, file))).digest("hex"));
    if (snapshots.length === 0) throw new Error("Compose migration did not create a non-empty pre-migration snapshot");
    return snapshots;
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

try {
  const nginxConfig = readFileSync("apps/web-vite/nginx.conf", "utf8");
  if (!nginxConfig.includes("proxy_set_header Host $http_host;")) {
    throw new Error("nginx must preserve the incoming Host header and port for Go same-origin checks");
  }
  const config = execFileSync("docker", [...composeArgs, "config", "--format", "json"], {
    cwd: process.cwd(),
    env: composeEnv,
    encoding: "utf8",
  });
  const services = JSON.parse(config).services;
  if (!services?.web || !services?.api || !services?.db || !services?.["jobs-worker"] || !services?.["outbox-worker"] || !services?.["role-principals"] || services?.app) {
    throw new Error("Compose must define web, api, both Go workers, database setup, and db without a legacy app service");
  }
  compose("up", "-d", "--build", "--wait", "--wait-timeout", "180");
  const runningWorkers = execFileSync("docker", [...composeArgs, "ps", "--status", "running", "-q", "jobs-worker", "outbox-worker"], {
    cwd: process.cwd(),
    env: composeEnv,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  if (runningWorkers.length !== 2) throw new Error("Both Go worker services must remain running after Compose startup");
  const originalSnapshotHashes = migrationSnapshotHashes();
  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", "migrate-schema");
  const persistedSnapshotHashes = migrationSnapshotHashes();
  if (!originalSnapshotHashes.some((hash) => persistedSnapshotHashes.includes(hash))) {
    throw new Error("The pre-migration snapshot did not survive migration-container recreation");
  }
  console.log("MIGRATION-SNAPSHOT-OK");
  await waitForHealth();
  const page = await fetch(`http://127.0.0.1:${webPort}/`);
  if (!page.ok || !(await page.text()).includes("/assets/")) {
    throw new Error(`Vite static app did not load: HTTP ${page.status}`);
  }
  const directApi = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
  if (!directApi.ok) throw new Error(`Go API direct health failed: HTTP ${directApi.status}`);
  const authStart = await fetch(`http://127.0.0.1:${webPort}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${webPort}`,
    },
    body: "{}",
  });
  const authBody = await authStart.json();
  if (authStart.status !== 400 || authBody.code === "INVALID_ORIGIN") {
    throw new Error(`Go auth origin check through nginx failed: HTTP ${authStart.status} ${JSON.stringify(authBody)}`);
  }
  console.log("DOCKER-VITE-GO-RUNTIME-OK");
} catch (error) {
  try {
    compose("logs", "--no-color");
  } catch (logError) {
    console.error("Compose failure logs were unavailable:", logError instanceof Error ? logError.message : String(logError));
  }
  throw error;
} finally {
  try {
    compose("down", "--volumes", "--remove-orphans");
  } catch (error) {
    console.error("Docker verification cleanup failed:", error instanceof Error ? error.message : String(error));
  }
}
