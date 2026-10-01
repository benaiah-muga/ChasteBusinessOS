import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const ROOT = process.cwd();
const TARGETS = [
  { name: "next", command: "pnpm dev:legacy", args: ["run", "dev:legacy"], url: "http://localhost:3001" },
  { name: "vite", command: "pnpm dev:vite", args: ["run", "dev:vite"], url: "http://localhost:3000" },
];
const DEFAULT_RUNS = 3;
const DEFAULT_OUTPUT = "docs/migration/benchmarks/phase-4-startup.json";
const STARTUP_TIMEOUT_MS = 120_000;

function parseArgs(args) {
  let runs = DEFAULT_RUNS;
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--runs") {
      runs = Number(args[index + 1]);
      index += 1;
    } else if (args[index] === "--output") {
      output = args[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown option: ${args[index]}`);
    }
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    throw new Error("--runs must be an integer from 1 to 20");
  }
  if (!output) throw new Error("--output requires a path");
  return { runs, output: path.resolve(ROOT, output) };
}

function commandVersion(command, args) {
  try {
    return spawnSync(command, args, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  } catch {
    return "unavailable";
  }
}

function gitRevision() {
  return commandVersion("git", ["rev-parse", "HEAD"]);
}

function cpuModel() {
  return os.cpus()[0]?.model ?? "unknown";
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function waitForListener(url, timeoutMilliseconds) {
  const target = new URL(url);
  const port = Number(target.port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, target.hostname);
    socket.setTimeout(timeoutMilliseconds, () => socket.destroy(new Error(`connection timed out after ${timeoutMilliseconds}ms`)));
    socket.once("connect", () => {
      socket.destroy();
      resolve(port);
    });
    socket.once("error", reject);
  });
}

export async function assertPortAvailable(target) {
  try {
    await waitForListener(target.url, 500);
  } catch {
    return;
  }
  throw new Error(`${target.url} already accepts TCP connections`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") process.kill(child.pid, "SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const exit = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exit, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === "win32") process.kill(child.pid, "SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function runStartup(target) {
  await assertPortAvailable(target);
  const startedAt = performance.now();
  const child = spawn("pnpm", target.args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-4_000); });
  }

  try {
    while (performance.now() - startedAt < STARTUP_TIMEOUT_MS) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${target.command} exited before readiness.\n${logs}`);
      }
      try {
        const port = await waitForListener(target.url, 500);
        const startupMilliseconds = Math.round(performance.now() - startedAt);
        return { startupMilliseconds, port };
      } catch {
        await delay(100);
      }
    }
    throw new Error(`${target.command} was not ready after ${STARTUP_TIMEOUT_MS}ms.\n${logs}`);
  } finally {
    await stopProcess(child);
  }
}

async function main() {
  const { runs, output } = parseArgs(process.argv.slice(2));
  const samples = Object.fromEntries(TARGETS.map(({ name }) => [name, []]));
  let failures = 0;

  for (let run = 1; run <= runs; run += 1) {
    const order = run % 2 === 1 ? TARGETS : [...TARGETS].reverse();
    for (const target of order) {
      process.stdout.write(`Run ${run}/${runs}: ${target.name} startup\n`);
      try {
        const result = await runStartup(target);
        samples[target.name].push({ run, ...result });
        process.stdout.write(`  ready=${result.startupMilliseconds}ms TCP=${result.port}\n`);
      } catch (error) {
        failures += 1;
        samples[target.name].push({ run, error: error.message });
        process.stderr.write(`  failed: ${error.message}\n`);
      }
    }
  }

  const summaries = Object.fromEntries(Object.entries(samples).map(([name, runsForTarget]) => {
    const successful = runsForTarget.filter((sample) => sample.startupMilliseconds !== undefined);
    const times = successful.map((sample) => sample.startupMilliseconds);
    return [name, {
      successfulRuns: successful.length,
      failedRuns: runsForTarget.length - successful.length,
      medianStartupMilliseconds: times.length ? median(times) : null,
      samples: runsForTarget,
    }];
  }));
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    gitRevision: gitRevision(),
    machine: {
      platform: `${os.platform()} ${os.release()}`,
      architecture: os.arch(),
      cpuModel: cpuModel(),
      logicalCpuCount: os.availableParallelism(),
      totalMemoryBytes: os.totalmem(),
    },
    toolchain: {
      node: process.version,
      pnpm: commandVersion("pnpm", ["--version"]),
    },
    protocol: {
      runsPerServer: runs,
      order: "Next then Vite on odd runs, Vite then Next on even runs",
      cachePolicy: "shared working tree and compiler caches, left warm between samples",
      measurement: "process spawn to first TCP listener connection on the frontend port; no HTTP or browser check",
      commands: Object.fromEntries(TARGETS.map(({ name, command, url }) => [name, { command, url }])),
    },
    summaries,
  };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${path.relative(ROOT, output)}\n`);
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
