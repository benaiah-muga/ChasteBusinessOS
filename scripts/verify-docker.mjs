/* global console, fetch, process, setTimeout */

import { execFileSync } from "node:child_process";

const project = "chaste-docker-verification";
const webPort = "3300";
const dbPort = "55433";
const composeEnv = {
  ...process.env,
  BETTER_AUTH_SECRET: "docker-verification-only-secret",
  CHASTE_WEB_PORT: webPort,
  CHASTE_DB_PORT: dbPort,
  NEXT_PUBLIC_APP_URL: `http://localhost:${webPort}`,
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
  throw new Error(`Docker app health check timed out: ${lastError}`);
}

try {
  compose("up", "-d", "--build", "--wait", "--wait-timeout", "180");
  await waitForHealth();
  console.log("DOCKER-RUNTIME-OK");
} finally {
  try {
    compose("down", "--volumes", "--remove-orphans");
  } catch (error) {
    console.error("Docker verification cleanup failed:", error instanceof Error ? error.message : String(error));
  }
}
