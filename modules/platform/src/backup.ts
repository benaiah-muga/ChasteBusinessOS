import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { ValidationError } from "@chaste/kernel";
import { and, eq, getTableColumns, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

/* ───────────────────────── Crypto (AES-256-GCM) ───────────────────────── */

/**
 * Backup encryption key from `CHASTE_BACKUP_KEY` (32 bytes hex). Restore only
 * accepts blobs whose key id matches, so a rotated key fails loudly instead of
 * silently producing garbage.
 */
export function getBackupKey(): Buffer {
  const hex = process.env.CHASTE_BACKUP_KEY;
  if (!hex) throw new Error("CHASTE_BACKUP_KEY is not set (32-byte hex)");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new Error("CHASTE_BACKUP_KEY must be a 32-byte hex string");
  return buf;
}

function keyId(): string {
  return createHash("sha256")
    .update(process.env.CHASTE_BACKUP_KEY ?? "")
    .digest("hex")
    .slice(0, 8);
}

export const encryptedBlobSchema = z.object({
  v: z.literal(1),
  alg: z.literal("aes-256-gcm"),
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ct: z.string(),
});

export type EncryptedBlob = z.infer<typeof encryptedBlobSchema>;

export function encryptBackup(plain: string): EncryptedBlob {
  const key = getBackupKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    keyId: keyId(),
    nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ct: ct.toString("hex"),
  };
}

export function decryptBackup(blob: EncryptedBlob): string {
  const key = getBackupKey();
  if (!timingSafeEqual(Buffer.from(blob.keyId, "utf8"), Buffer.from(keyId(), "utf8"))) {
    throw new Error("Backup was encrypted with a different key");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.nonce, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, "hex")), decipher.final()]).toString(
    "utf8",
  );
}

/* ───────────────────────── Snapshot / manifest ────────────────────────── */

export const backupManifestSchema = z.object({
  schema: z.literal("chaste-backup.v1"),
  exportedAt: z.string(),
  organizationId: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

/**
 * Tables snapshot straight from `organization_id`. Each logical name maps to
 * the drizzle table object so restore can target the same column set.
 */
const DIRECT_TABLES = {
  branches: { table: schema.branches },
  roles: { table: schema.roles },
  users: { table: schema.users },
  businessPartners: { table: schema.businessPartners },
  moduleInstalls: { table: schema.moduleInstalls },
  capabilityGapTickets: { table: schema.capabilityGapTickets },
  chatSessions: { table: schema.chatSessions },
  reminders: { table: schema.reminders },
  followUps: { table: schema.followUps },
  calendars: { table: schema.calendars },
  calendarEvents: { table: schema.calendarEvents },
  notifications: { table: schema.notifications },
  emailOutbox: { table: schema.emailOutbox },
  msgThreads: { table: schema.msgThreads },
  msgMessages: { table: schema.msgMessages },
  pendingApprovals: { table: schema.pendingApprovals },
  aiSkills: { table: schema.aiSkills },
  channelSessionBindings: { table: schema.channelSessionBindings },
  aiExplanations: { table: schema.aiExplanations },
  orgMemories: { table: schema.orgMemories },
  crmCustomers: { table: schema.crmCustomers },
  crmContacts: { table: schema.crmContacts },
  crmInteractions: { table: schema.crmInteractions },
  accAccounts: { table: schema.accAccounts },
  accJournalEntries: { table: schema.accJournalEntries },
  accInvoices: { table: schema.accInvoices },
  invWarehouses: { table: schema.invWarehouses },
  invProducts: { table: schema.invProducts },
  invStockLevels: { table: schema.invStockLevels },
  invStockMoves: { table: schema.invStockMoves },
  purVendors: { table: schema.purVendors },
  purPurchaseOrders: { table: schema.purPurchaseOrders },
  hrEmployees: { table: schema.hrEmployees },
  hrPayrollRuns: { table: schema.hrPayrollRuns },
  mfgBoms: { table: schema.mfgBoms },
  mfgWorkOrders: { table: schema.mfgWorkOrders },
  workflowDefinitions: { table: schema.workflowDefinitions },
  workflowRuns: { table: schema.workflowRuns },
} as const;

/**
 * Tables without an `organization_id` column that carry rows belonging to an
 * org via a parent table. Resolved with an EXISTS subquery at snapshot time.
 */
const JOIN_TABLES = {
  userRoles: { table: schema.userRoles, parent: schema.users, fk: schema.userRoles.userId },
  rolePermissions: {
    table: schema.rolePermissions,
    parent: schema.roles,
    fk: schema.rolePermissions.roleId,
  },
  userBranchAccess: {
    table: schema.userBranchAccess,
    parent: schema.users,
    fk: schema.userBranchAccess.userId,
  },
  chatMessages: {
    table: schema.chatMessages,
    parent: schema.chatSessions,
    fk: schema.chatMessages.sessionId,
  },
  msgThreadMembers: {
    table: schema.msgThreadMembers,
    parent: schema.msgThreads,
    fk: schema.msgThreadMembers.threadId,
  },
  msgReads: { table: schema.msgReads, parent: schema.msgThreads, fk: schema.msgReads.threadId },
  accJournalLines: {
    table: schema.accJournalLines,
    parent: schema.accJournalEntries,
    fk: schema.accJournalLines.entryId,
  },
  mfgBomLines: { table: schema.mfgBomLines, parent: schema.mfgBoms, fk: schema.mfgBomLines.bomId },
} as const;

/** Snapshot order on restore: parents before children (FK safety). */
const RESTORE_ORDER: string[] = [
  "organizations",
  "branches",
  "roles",
  "users",
  "userRoles",
  "rolePermissions",
  "userBranchAccess",
  "moduleInstalls",
  "capabilityGapTickets",
  "chatSessions",
  "chatMessages",
  "reminders",
  "followUps",
  "calendars",
  "calendarEvents",
  "notifications",
  "emailOutbox",
  "msgThreads",
  "msgThreadMembers",
  "msgMessages",
  "msgReads",
  "pendingApprovals",
  "aiSkills",
  "channelSessionBindings",
  "aiExplanations",
  "orgMemories",
  "businessPartners",
  "crmCustomers",
  "crmContacts",
  "crmInteractions",
  "accAccounts",
  "accJournalEntries",
  "accJournalLines",
  "accInvoices",
  "invWarehouses",
  "invProducts",
  "invStockLevels",
  "invStockMoves",
  "purVendors",
  "purPurchaseOrders",
  "hrEmployees",
  "hrPayrollRuns",
  "mfgBoms",
  "mfgBomLines",
  "mfgWorkOrders",
  "workflowDefinitions",
  "workflowRuns",
];

type SnapshotResult = Record<string, Record<string, unknown>[]>;

/**
 * Capture every org-scoped row across the curated table set. The `outboxEvents`
 * and `auditLog` tables are intentionally excluded: outbox events would replay
 * side effects on restore, and the audit log is append-only by design.
 */
export async function snapshotOrganization(
  db: Db,
  organizationId: string,
): Promise<SnapshotResult> {
  const tables: SnapshotResult = {};

  const [orgRow] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);
  tables.organizations = orgRow ? [orgRow as unknown as Record<string, unknown>] : [];

  const existing = await new ColumnResolver(db);
  for (const [name, { table }] of Object.entries(DIRECT_TABLES)) {
    const shape = await existing.selectShape(table);
    const rows = await db
      .select(shape as never)
      .from(table as never)
      .where(eq((table as any).organizationId, organizationId));
    tables[name] = rows as unknown as Record<string, unknown>[];
  }

  for (const [name, { table, parent, fk }] of Object.entries(JOIN_TABLES)) {
    const parentRows = await db
      .select({ id: parent.id })
      .from(parent)
      .where(eq(parent.organizationId, organizationId));
    const parentIds = parentRows.map((r) => r.id);
    if (parentIds.length === 0) {
      tables[name] = [];
      continue;
    }
    const shape = await existing.selectShape(table);
    const rows = await db
      .select(shape as never)
      .from(table as never)
      .where(inArray(fk as any, parentIds));
    tables[name] = rows as unknown as Record<string, unknown>[];
  }

  return tables;
}

/** DB table name for a drizzle table object. */
function dbTableName(table: any): string {
  return (table?.[Symbol.for("drizzle:Name")] as string) ?? "";
}

/**
 * Resolves each table's column set from `information_schema` once, so snapshot
 * and restore tolerate schema drift between `schema.ts` and the live database
 * (e.g. renamed columns). Snapshot only selects columns that actually exist.
 */
class ColumnResolver {
  private cache = new Map<string, Set<string>>();

  constructor(private db: Db) {}

  private async tableColumns(table: any): Promise<Set<string>> {
    const tableName = dbTableName(table);
    const hit = this.cache.get(tableName);
    if (hit) return hit;
    const res = await this.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = ${tableName}`,
    );
    const cols = new Set(res.map((r) => r.column_name));
    this.cache.set(tableName, cols);
    return cols;
  }

  async selectShape(table: any): Promise<Record<string, unknown>> {
    const dbCols = await this.tableColumns(table);
    const shape: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(getTableColumns(table))) {
      if (dbCols.has((column as { name: string }).name)) shape[key] = column;
    }
    return shape;
  }
}

/** Build a versioned, checksum-able manifest for an org. */
export function buildManifest(
  organizationId: string,
  tables: SnapshotResult,
  exportedAt = new Date().toISOString(),
): BackupManifest {
  return { schema: "chaste-backup.v1", exportedAt, organizationId, tables };
}

export function manifestChecksum(manifest: BackupManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/* ───────────────────────── Object store ──────────────────────────────── */

export interface ObjectStore {
  readonly id: string;
  put(key: string, data: string): Promise<void>;
  get(key: string): Promise<string>;
}

/** Null store: surfaces a clear error when no provider is configured. */
export function createNullStore(): ObjectStore {
  return {
    id: "none",
    async put() {
      throw new Error("No object store configured — set CHASTE_S3_BUCKET or CHASTE_BACKUP_DIR");
    },
    async get() {
      throw new Error("No object store configured — set CHASTE_S3_BUCKET or CHASTE_BACKUP_DIR");
    },
  };
}

/** In-memory store for tests and single-process dev. */
export function createMemoryStore(backing = new Map<string, string>()): ObjectStore {
  return {
    id: "memory",
    async put(key, data) {
      backing.set(key, data);
    },
    async get(key) {
      const data = backing.get(key);
      if (data === undefined) throw new Error(`Object not found: ${key}`);
      return data;
    },
  };
}

/** Filesystem store rooted at `dir` (e.g. `CHASTE_BACKUP_DIR`). */
export function createLocalStore(dir: string): ObjectStore {
  return {
    id: "local",
    async put(key, data) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");
      const file = join(dir, ...key.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data, "utf8");
    },
    async get(key) {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const file = join(dir, ...key.split("/"));
      return readFile(file, "utf8");
    },
  };
}

/* Minimal AWS SigV4 S3 client (no SDK dependency) — works for AWS and
 * S3-compatible endpoints (MinIO, R2, GCS S3 API). */
export function createS3Store(): ObjectStore {
  const bucket = process.env.CHASTE_S3_BUCKET;
  const accessKeyId = process.env.CHASTE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CHASTE_S3_SECRET_ACCESS_KEY;
  const sessionToken = process.env.CHASTE_S3_SESSION_TOKEN;
  const region = process.env.CHASTE_S3_REGION ?? "us-east-1";
  const endpoint = process.env.CHASTE_S3_ENDPOINT;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "CHASTE_S3_BUCKET / CHASTE_S3_ACCESS_KEY_ID / CHASTE_S3_SECRET_ACCESS_KEY are required",
    );
  }

  const baseUrl = endpoint ?? `https://${bucket}.s3.${region}.amazonaws.com`;

  return {
    id: "s3",
    async put(key, data) {
      const body = Buffer.from(data, "utf8");
      const url = new URL(`${baseUrl}/${encodePath(key)}`);
      await s3Request("PUT", url, body, {
        bucket,
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
    },
    async get(key) {
      const url = new URL(`${baseUrl}/${encodePath(key)}`);
      const res = await s3Request("GET", url, undefined, {
        bucket,
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      return res.text();
    },
  };
}

function encodePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

interface S3Auth {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

async function s3Request(
  method: "GET" | "PUT",
  url: URL,
  body: Buffer | undefined,
  auth: S3Auth,
): Promise<Response> {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256")
    .update(body ?? Buffer.from(""))
    .digest("hex");

  const signedHeaders = ["host"];
  let extraHeaders: Record<string, string> = {
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (auth.sessionToken) {
    extraHeaders["x-amz-security-token"] = auth.sessionToken;
    signedHeaders.push("x-amz-security-token");
  }
  signedHeaders.push("x-amz-content-sha256", "x-amz-date");

  const canonicalHeaders = signedHeaders
    .sort()
    .map((h) => `${h}:${(extraHeaders[h] ?? "").trim()}\n`)
    .join("");
  const canonicalRequest = [
    method,
    url.pathname,
    url.search.slice(1),
    canonicalHeaders,
    signedHeaders.sort().join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${auth.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const signingKey = hmacChain(
    `AWS4${auth.secretAccessKey}`,
    dateStamp,
    auth.region,
    "s3",
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const headers: Record<string, string> = {
    ...extraHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${auth.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.sort().join(";")}, Signature=${signature}`,
  };
  if (body) headers["content-length"] = String(body.length);

  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    throw new Error(
      `S3 ${method} ${url.pathname} failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
  return res;
}

function hmacChain(key: Buffer | string, ...parts: string[]): Buffer {
  return parts.reduce<Buffer>(
    (k, p) => createHmac("sha256", k).update(p).digest(),
    Buffer.from(key),
  );
}

/** Env-driven store factory, mirroring `createEmailAdapter`. */
export function createObjectStore(): ObjectStore {
  if (process.env.CHASTE_S3_BUCKET) return createS3Store();
  if (process.env.CHASTE_BACKUP_DIR) return createLocalStore(process.env.CHASTE_BACKUP_DIR);
  return createNullStore();
}

export function objectStoreStatus(): {
  provider: "s3" | "local" | "memory" | "none";
  encryptionConfigured: boolean;
} {
  let provider: "s3" | "local" | "memory" | "none" = "none";
  if (process.env.CHASTE_S3_BUCKET) provider = "s3";
  else if (process.env.CHASTE_BACKUP_DIR) provider = "local";
  return { provider, encryptionConfigured: Boolean(process.env.CHASTE_BACKUP_KEY) };
}

/* ───────────────────────── Processor (worker) ────────────────────────── */

export function createBackupProcessor(db: Db, store: ObjectStore = createObjectStore()) {
  return {
    provider: store.id,
    /**
     * Drain queued backup jobs like `flushEmailOutbox`: claim, snapshot,
     * encrypt, store, then record the result. Jobs left in `running` past the
     * lease (crash recovery) are reclaimed to `queued`.
     */
    async flushBackupJobs(batch = 5, leaseMs = 10 * 60_000): Promise<number> {
      if (leaseMs > 0) {
        const cutoff = new Date(Date.now() - leaseMs);
        await db
          .update(schema.backups)
          .set({ status: "queued", error: null })
          .where(and(eq(schema.backups.status, "running"), lt(schema.backups.createdAt, cutoff)));
      }
      const queued = await db
        .select()
        .from(schema.backups)
        .where(eq(schema.backups.status, "queued"))
        .limit(batch);
      if (queued.length === 0) return 0;

      await db
        .update(schema.backups)
        .set({ status: "running" })
        .where(
          inArray(
            schema.backups.id,
            queued.map((r) => r.id),
          ),
        );

      let done = 0;
      for (const job of queued) {
        try {
          const result = await runBackupJob(db, store, job.id, job.organizationId);
          await db
            .update(schema.backups)
            .set({
              status: "success",
              provider: store.id,
              storageKey: result.storageKey,
              sizeBytes: result.sizeBytes,
              checksum: result.checksum,
              completedAt: new Date(),
              error: null,
            })
            .where(eq(schema.backups.id, job.id));
          done += 1;
        } catch (err) {
          await db
            .update(schema.backups)
            .set({
              status: "failed",
              provider: store.id,
              error: err instanceof Error ? err.message : String(err),
            })
            .where(eq(schema.backups.id, job.id));
        }
      }
      return done;
    },
  };
}

export async function runBackupJob(
  db: Db,
  store: ObjectStore,
  jobId: string,
  organizationId: string,
): Promise<{ storageKey: string; sizeBytes: number; checksum: string }> {
  const tables = await snapshotOrganization(db, organizationId);
  const manifest = buildManifest(organizationId, tables);
  const checksum = manifestChecksum(manifest);
  const blob = encryptBackup(JSON.stringify(manifest));
  const payload = JSON.stringify(blob);
  const storageKey = `orgs/${organizationId}/backups/${jobId}.json.enc`;
  await store.put(storageKey, payload);
  return { storageKey, sizeBytes: Buffer.byteLength(payload), checksum };
}

/* ───────────────────────── Restore ───────────────────────────────────── */

export async function fetchAndDecrypt(
  store: ObjectStore,
  storageKey: string,
): Promise<BackupManifest> {
  const raw = await store.get(storageKey);
  const blob = encryptedBlobSchema.parse(JSON.parse(raw));
  const plain = decryptBackup(blob);
  return backupManifestSchema.parse(JSON.parse(plain));
}

/** Idempotent upsert of a validated manifest into the database. */
export async function applyManifest(
  db: Db,
  manifest: BackupManifest,
): Promise<{ restoredTables: number; rowCount: number }> {
  const allTables = {
    organizations: { table: schema.organizations },
    ...DIRECT_TABLES,
    ...JOIN_TABLES,
  } as Record<string, { table: any }>;
  let restoredTables = 0;
  let rowCount = 0;

  for (const name of RESTORE_ORDER) {
    const rows = manifest.tables[name];
    if (!rows || rows.length === 0) continue;
    const { table } = allTables[name] ?? {};
    if (!table) continue;

    const columns = getTableColumns(table) as Record<string, { name: string; dataType: string }>;
    const set: Record<string, unknown> = {};
    for (const key of Object.keys(rows[0] ?? {})) {
      if (key === "id") continue;
      const column = columns[key];
      if (!column) continue;
      set[key] = sql`excluded.${sql.identifier(column.name)}`;
    }

    const coerced = rows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const [key, column] of Object.entries(columns)) {
        if (column.dataType === "date" && typeof out[key] === "string") {
          out[key] = new Date(out[key]);
        }
      }
      return out;
    });

    await db
      .insert(table)
      .values(coerced as never)
      .onConflictDoUpdate({ target: table.id, set });
    restoredTables += 1;
    rowCount += rows.length;
  }

  return { restoredTables, rowCount };
}

export async function restoreFromStore(
  db: Db,
  store: ObjectStore,
  storageKey: string,
  expectedOrgId?: string,
) {
  const manifest = await fetchAndDecrypt(store, storageKey);
  // F14 — if the caller expects a specific org, refuse to restore a backup
  // that belongs to a different organization (cross-tenant data import).
  if (expectedOrgId && manifest.organizationId !== expectedOrgId) {
    throw new ValidationError("Backup belongs to a different organization");
  }
  const result = await applyManifest(db, manifest);
  return { organizationId: manifest.organizationId, ...result };
}
