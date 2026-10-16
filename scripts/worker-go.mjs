import { spawn } from "node:child_process";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { jobsWorkerEnvironment, selectedEnvironment } from "./worker-go-env.mjs";

const workerNames = ["jobs-worker", "outbox-worker", "marketing-email-worker", "notification-email-worker"];
const directory = mkdtempSync(join(tmpdir(), "chaste-workers-"));
const buildChildren = new Set();
const workerChildren = new Set();
const workerPromises = [];
let stopping = false;
let failed = false;

const buildKeys = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "GOCACHE", "GOMODCACHE",
  "GOPATH", "GOROOT", "GOENV", "GOTOOLCHAIN", "GOOS", "GOARCH", "CGO_ENABLED",
  "GOPROXY", "GOSUMDB", "GONOSUMDB", "GOPRIVATE", "GOWORK",
];
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
    run("jobs-worker", jobsWorkerEnvironment());
    run("outbox-worker", selectedEnvironment(["OUTBOX_WORKER_DATABASE_URL", "OUTBOX_WORKER_ID"]));
    run("marketing-email-worker", selectedEnvironment([
      "MARKETING_EMAIL_OUTBOX_WORKER_DATABASE_URL",
      "MARKETING_EMAIL_OUTBOX_WORKER_ID",
      "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM",
    ]));
    run("notification-email-worker", selectedEnvironment([
      "NOTIFICATION_EMAIL_OUTBOX_WORKER_DATABASE_URL",
      "NOTIFICATION_EMAIL_OUTBOX_WORKER_ID",
      "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM",
    ]));
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
