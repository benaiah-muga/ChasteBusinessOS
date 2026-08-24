import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Single entry point for schema migrations, used by `pnpm db:migrate` and by
 * the web app's boot hook (apps/web/src/instrumentation.ts).
 *
 * Safety model for user data:
 *  - Postgres advisory lock serializes concurrent boots (multi-instance
 *    deploys) so two servers can never race the same migration.
 *  - A pg_dump snapshot is taken before the first change of this run, so a
 *    bad migration is recoverable by restore rather than by hope. Snapshots
 *    land in packages/db/backups/ (gitignored), pruned to the newest 10.
 *  - drizzle's migrator applies only pending migrations, each in its own
 *    transaction: re-running is always safe, and a failed migration rolls
 *    itself back instead of leaving a half-altered schema.
 *
 * Backup policy: the snapshot prefers the host pg_dump (override with
 * CHASTE_PG_DUMP_BIN); if that binary is missing or older than the server
 * (the classic distro-client trap), it falls back to pg_dump inside the
 * chaste-pgvector container (rename with CHASTE_DB_CONTAINER). If no dump
 * path works the run continues with a loud warning by default; set
 * CHASTE_STRICT_MIGRATION_BACKUP=1 to refuse migrating without a verified
 * snapshot (recommended for production).
 */

/** Arbitrary but stable org-wide lock id; any constant works as long as every deploy uses the same one. */
export const MIGRATION_LOCK_KEY = 824_611_001;

const KEEP_BACKUPS = 10;

export interface MigrationResult {
  /** Path of the pre-migration snapshot, when one was taken. */
  backupPath: string | null;
  /** Human-readable reason when no snapshot was taken (warning surface). */
  backupSkippedReason: string | null;
}

/**
 * Locates the @chaste/db package root whether this code runs from source
 * (tsx scripts, tests) or from a bundled server (Next instrumentation):
 * bundlers rewrite import.meta.url, and literal `new URL(rel, import.meta.url)`
 * forms get misread as asset imports, so resolution goes through Node's
 * require machinery, which follows the pnpm symlink to the real monorepo dir.
 */
function packageRoot(): string {
  const selfUrl = fileURLToPath(import.meta.url);
  // Running from source inside the package itself: src/migrate.ts.
  if (selfUrl.includes(`${sep}packages${sep}db${sep}src${sep}`)) {
    return resolve(dirname(selfUrl), "..");
  }
  const req = createRequire(selfUrl);
  return dirname(req.resolve("@chaste/db/package.json"));
}

export function migrationsFolder(): string {
  return resolve(packageRoot(), "drizzle");
}

export function backupsDir(): string {
  const dir = resolve(packageRoot(), "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface DumpOutcome {
  ok: boolean;
  error?: string;
}

function runDump(cmd: string, args: string[], outFile: string): Promise<DumpOutcome> {
  return new Promise((promiseResolve) => {
    let settled = false;
    const settle = (result: DumpOutcome): void => {
      if (!settled) {
        settled = true;
        promiseResolve(result);
      }
    };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const out = createWriteStream(outFile);
    child.stdout?.pipe(out);
    // Captured up front: for an instantly-failing dump the stream can close
    // before the child "close" event is delivered, so a listener registered
    // inside that handler would never fire.
    const outClosed = new Promise<void>((resolveOut) => {
      out.on("close", () => resolveOut());
      out.on("error", () => resolveOut());
    });
    child.on("error", (err) => {
      outClosed.then(() => settle({ ok: false, error: err.message }));
    });
    child.on("close", (code) => {
      outClosed.then(() => {
        const size = statSync(outFile, { throwIfNoEntry: false })?.size ?? 0;
        if (code === 0 && size > 0) settle({ ok: true });
        else settle({ ok: false, error: stderr.trim() || `${cmd} exited with code ${code}` });
      });
    });
  });
}

/** Host pg_dump; override with CHASTE_PG_DUMP_BIN ("command with optional flags"). */
function directDump(url: string, outFile: string): Promise<DumpOutcome> {
  const bin = process.env.CHASTE_PG_DUMP_BIN;
  if (bin) {
    const [cmd, ...flags] = bin.trim().split(/\s+/);
    return runDump(cmd!, [...flags, "--dbname", url, "--no-owner", "--no-privileges"], outFile);
  }
  return runDump("pg_dump", ["--dbname", url, "--no-owner", "--no-privileges"], outFile);
}

/**
 * Fallback for the classic self-hosted trap: the distro's pg_dump is older
 * than the server (e.g. Ubuntu 22.04 ships client 14 against a Postgres 16
 * container), which makes every dump abort. The dev database lives in the
 * chaste-pgvector container whose own pg_dump always matches its server, so
 * stream the dump through `docker exec` instead.
 */
async function dockerFallbackAvailable(): Promise<boolean> {
  try {
    await new Promise<void>((resolveP, rejectP) => {
      execFile("docker", ["info", "--format", "ok"], (err) => (err ? rejectP(err) : resolveP()));
    });
    return true;
  } catch {
    return false;
  }
}

function urlParts(url: string): { user: string; database: string } {
  const parsed = new URL(url);
  return { user: parsed.username || "postgres", database: decodeURIComponent(parsed.pathname.slice(1)) };
}

async function dockerDump(url: string, outFile: string): Promise<DumpOutcome> {
  const container = process.env.CHASTE_DB_CONTAINER ?? "chaste-pgvector";
  const { user, database } = urlParts(url);
  return runDump("docker", ["exec", container, "pg_dump", "-U", user, database], outFile);
}

async function snapshot(url: string): Promise<string> {
  const dir = backupsDir();
  // Atomic-enough temp name: concurrent runs are already excluded by the
  // advisory lock, the suffix only disambiguates restarts within one second.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = resolve(dir, `pre-migrate-${stamp}-${process.pid}.sql`);
  const tempPath = `${finalPath}.partial`;

  let outcome = await directDump(url, tempPath);
  if (!outcome.ok && !process.env.CHASTE_PG_DUMP_BIN) {
    const versionMismatch = /version mismatch|server version:/i.test(outcome.error ?? "");
    if ((versionMismatch || /ENOENT/.test(outcome.error ?? "")) && (await dockerFallbackAvailable())) {
      outcome = await dockerDump(url, tempPath);
    }
  }
  if (!outcome.ok || statSync(tempPath).size === 0) {
    rmSync(tempPath, { force: true });
    throw new Error(
      outcome.error ||
        "pg_dump produced an empty snapshot" +
          (process.env.CHASTE_PG_DUMP_BIN
            ? ""
            : " (hint: install a postgresql-client matching your server version, or set CHASTE_PG_DUMP_BIN)"),
    );
  }
  renameSync(tempPath, finalPath);
  pruneOldBackups(dir);
  return finalPath;
}

function pruneOldBackups(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => /^pre-migrate-.*\.sql$/.test(f))
    .map((f) => ({ f, mtime: statMtime(resolve(dir, f)) }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of files.slice(KEEP_BACKUPS)) rmSync(resolve(dir, old.f), { force: true });
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export async function runMigrations(options: { url?: string } = {}): Promise<MigrationResult> {
  const url =
    options.url ?? process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

  const client = postgres(url, { max: 1 });
  try {
    await client.unsafe(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    let backupPath: string | null = null;
    let backupSkippedReason: string | null = null;
    if (process.env.CHASTE_SKIP_MIGRATION_BACKUP === "1") {
      backupSkippedReason = "pre-migration snapshot disabled via CHASTE_SKIP_MIGRATION_BACKUP=1";
    } else {
      try {
        backupPath = await snapshot(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (process.env.CHASTE_STRICT_MIGRATION_BACKUP === "1") {
          throw new Error(`refusing to migrate without a pre-migration snapshot: ${message}`);
        }
        backupSkippedReason = `migrated WITHOUT pre-migration snapshot: ${message}`;
      }
    }
    await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
    return { backupPath, backupSkippedReason };
  } finally {
    await client.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).catch(() => {});
    await client.end();
  }
}
