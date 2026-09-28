import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const DEFAULT_RUNS = 10;
const DEFAULT_OUTPUT = "docs/migration/benchmarks/phase-0-builds.json";
const BUILD_COMMANDS = [
  { name: "next", command: "pnpm", args: ["--filter", "web", "build"] },
  { name: "vite", command: "pnpm", args: ["--filter", "@chaste/web-vite", "build"] },
  {
    name: "go",
    command: "go",
    args: ["-C", "apps/api", "build", "./cmd/api", "./cmd/jobs-worker", "./cmd/outbox-worker"],
  },
];

function parseArgs(args) {
  let runs = DEFAULT_RUNS;
  let output = DEFAULT_OUTPUT;
  let selectedNames = BUILD_COMMANDS.map(({ name }) => name);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runs") {
      runs = Number(args[index + 1]);
      index += 1;
    } else if (arg === "--output") {
      output = args[index + 1];
      index += 1;
    } else if (arg === "--only") {
      selectedNames = [args[index + 1]];
      index += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
    throw new Error("--runs must be an integer from 1 to 50");
  }
  if (!output) throw new Error("--output requires a path");
  const selected = BUILD_COMMANDS.filter(({ name }) => selectedNames.includes(name));
  if (selected.length !== selectedNames.length) {
    throw new Error(`--only must be one of: ${BUILD_COMMANDS.map(({ name }) => name).join(", ")}`);
  }
  return { runs, output: path.resolve(ROOT, output), selected };
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function cpuModel() {
  try {
    return readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m)?.[1] ?? os.cpus()[0]?.model ?? "unknown";
  } catch {
    return os.cpus()[0]?.model ?? "unknown";
  }
}

function totalMemoryBytes() {
  try {
    const match = readFileSync("/proc/meminfo", "utf8").match(/^MemTotal:\s+(\d+) kB$/m);
    return match ? Number(match[1]) * 1024 : os.totalmem();
  } catch {
    return os.totalmem();
  }
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function runBuild(root, command, args, timeOutputPath) {
  const result = spawnSync(
    "/usr/bin/time",
    ["-f", "wall_seconds=%e\\nmax_rss_kb=%M", "-o", timeOutputPath, "--", command, ...args],
    {
      cwd: root,
      env: { ...process.env, CI: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  const metrics = readFileSync(timeOutputPath, "utf8");
  const wall = metrics.match(/^wall_seconds=([\d.]+)$/m)?.[1];
  const maxRSS = metrics.match(/^max_rss_kb=(\d+)$/m)?.[1];
  return {
    exitCode: result.status,
    wallSeconds: wall === undefined ? null : Number(wall),
    maxRSSKilobytes: maxRSS === undefined ? null : Number(maxRSS),
  };
}

function gitRevision() {
  return commandVersion("git", ["rev-parse", "HEAD"]);
}

function main() {
  const { runs, output, selected } = parseArgs(process.argv.slice(2));
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "chaste-build-benchmark-"));
  const samples = Object.fromEntries(selected.map(({ name }) => [name, []]));
  let failures = 0;

  try {
    for (let run = 1; run <= runs; run += 1) {
      for (const build of selected) {
        const metricsPath = path.join(temporaryDirectory, `${run}-${build.name}.txt`);
        process.stdout.write(`Run ${run}/${runs}: ${build.name}\n`);
        const result = runBuild(ROOT, build.command, build.args, metricsPath);
        samples[build.name].push({ run, ...result });
        if (result.exitCode !== 0) failures += 1;
        process.stdout.write(
          `  exit=${result.exitCode} wall=${result.wallSeconds ?? "unknown"}s peakRSS=${result.maxRSSKilobytes ?? "unknown"}kB\n`,
        );
      }
    }

    const summaries = Object.fromEntries(
      Object.entries(samples).map(([name, runsForBuild]) => {
        const successful = runsForBuild.filter((sample) => sample.exitCode === 0 && sample.wallSeconds !== null);
        const wallTimes = successful.map((sample) => sample.wallSeconds);
        const peakRSS = successful.map((sample) => sample.maxRSSKilobytes).filter(Number.isFinite);
        return [
          name,
          {
            successfulRuns: successful.length,
            failedRuns: runsForBuild.length - successful.length,
            medianWallSeconds: wallTimes.length ? median(wallTimes) : null,
            p95WallSeconds: wallTimes.length ? percentile(wallTimes, 0.95) : null,
            medianPeakRSSKilobytes: peakRSS.length ? median(peakRSS) : null,
            samples: runsForBuild,
          },
        ];
      }),
    );
    const report = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      gitRevision: gitRevision(),
      machine: {
        platform: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpuModel: cpuModel(),
        logicalCpuCount: os.availableParallelism(),
        totalMemoryBytes: totalMemoryBytes(),
      },
      toolchain: {
        node: process.version,
        pnpm: commandVersion("pnpm", ["--version"]),
        go: commandVersion("go", ["-C", "apps/api", "version"]),
      },
      protocol: {
        runsPerBuild: runs,
        order: "Next, Vite, then Go, sequentially per run",
        cachePolicy: "shared working-tree dependency and compiler caches, left warm between samples",
        metrics: "GNU time wall clock and maximum resident set size for each full command",
        commands: Object.fromEntries(selected.map(({ name, command, args }) => [name, [command, ...args]])),
      },
      summaries,
    };

    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Report: ${path.relative(ROOT, output)}\n`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
