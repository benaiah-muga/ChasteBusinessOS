import { spawn } from "node:child_process";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const workerNames = ["jobs-worker", "outbox-worker"];
const directory = mkdtempSync(join(tmpdir(), "chaste-workers-"));
const buildChildren = new Set();
const workerChildren = new Set();
const workerPromises = [];
let stopping = false;
let failed = false;

const commonKeys = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SystemRoot", "WINDIR", "PATHEXT",
];
const buildKeys = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "GOCACHE", "GOMODCACHE",
  "GOPATH", "GOROOT", "GOENV", "GOTOOLCHAIN", "GOOS", "GOARCH", "CGO_ENABLED",
  "GOPROXY", "GOSUMDB", "GONOSUMDB", "GOPRIVATE", "GOWORK",
];
const jobsKeys = [
  "JOBS_WORKER_DATABASE_URL", "JOBS_WORKER_ID", "GO_DATABASE_URL",
  "GO_ROUTINE_SCHEDULER", "GO_ROUTINE_AGENT_RUNNER", "GO_SUPPORT_EMBEDDING_WORKER",
  "GO_SUPPORT_EMBEDDING_MODEL", "MODEL_PROVIDER", "MODEL_PRIMARY", "MODEL_FAST",
  "MODEL_REASONING", "MODEL_EMBEDDINGS", "MODEL_BASE_URL", "NIM_BASE_URL", "ZAI_BASE_URL",
  "EMBEDDING_DIMENSIONS", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY",
  "MISTRAL_API_KEY", "ZAI_API_KEY", "OPENAI_API_KEY", "NOTIFICATION_WEBHOOK_URL",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE", "SMTP_TO",
];

function selectedEnvironment(keys) {
  const result = {};
  for (const key of new Set([...commonKeys, ...keys])) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function buildEnvironment() {
  const result = {};
  for (const key of buildKeys) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of [...buildChildren, ...workerChildren]) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

function build(name) {
  return new Promise((resolve, reject) => {
    const child = spawn("go", ["-C", "apps/api", "build", "-o", join(directory, name), `./cmd/${name}`], {
      stdio: "inherit",
      env: buildEnvironment(),
    });
    buildChildren.add(child);
    child.once("error", (error) => {
      buildChildren.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      buildChildren.delete(child);
      if (stopping || code === 0) resolve();
      else reject(new Error(`building ${name} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

function run(name, env) {
  const child = spawn(join(directory, name), [], { stdio: "inherit", env });
  workerChildren.add(child);
  const exited = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      workerChildren.delete(child);
      resolve();
    };
    child.once("error", (error) => {
      console.error(error);
      failed = true;
      stop("SIGTERM");
      finish();
    });
    child.once("exit", (code, signal) => {
      if (!stopping) {
        failed = true;
        stop("SIGTERM");
      } else if (code !== 0 && signal === null) {
        failed = true;
      }
      finish();
    });
  });
  workerPromises.push(exited);
}

try {
  for (const name of workerNames) {
    await build(name);
    if (stopping) break;
  }
  if (!stopping) {
    run("jobs-worker", {
      ...selectedEnvironment(jobsKeys),
      GO_ROUTINE_SCHEDULER: process.env.GO_ROUTINE_SCHEDULER ?? "1",
      GO_ROUTINE_AGENT_RUNNER: process.env.GO_ROUTINE_AGENT_RUNNER ?? "1",
    });
    run("outbox-worker", selectedEnvironment(["OUTBOX_WORKER_DATABASE_URL", "OUTBOX_WORKER_ID"]));
    await Promise.all(workerPromises);
  }
} catch (error) {
  if (!stopping) {
    failed = true;
    console.error(error);
  }
  stop("SIGTERM");
  await Promise.all(workerPromises);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
