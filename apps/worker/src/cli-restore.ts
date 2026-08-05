/**
 * CLI restore — apply an encrypted backup file or store key back into the
 * database. Idempotent: rows are upserted on primary key.
 *
 *   pnpm restore --file ./backup.json.enc
 *   pnpm restore --store orgs/<orgId>/backups/<id>.json.enc
 *
 * Requires DATABASE_URL and CHASTE_BACKUP_KEY. The store target is read from
 * CHASTE_S3_* / CHASTE_BACKUP_DIR exactly like the worker.
 */
import { loadConfig } from "@chaste/config";
import { createDb } from "@chaste/db";
import { applyManifest, createObjectStore, decryptBackup, encryptedBlobSchema, backupManifestSchema } from "@chaste/module-platform";

function usage(): never {
  console.error("Usage: restore --file <path.enc> | --store <storageKey>");
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const storeIdx = args.indexOf("--store");
  if ((fileIdx === -1) === (storeIdx === -1)) usage();
  const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  const storeKey = storeIdx >= 0 ? args[storeIdx + 1] : undefined;
  if ((file && storeKey) || (!file && !storeKey)) usage();

  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl);

  let raw: string;
  if (file) {
    const { readFile } = await import("node:fs/promises");
    raw = await readFile(file, "utf8");
  } else {
    const store = createObjectStore();
    raw = await store.get(storeKey!);
  }

  const blob = encryptedBlobSchema.parse(JSON.parse(raw));
  const plain = decryptBackup(blob);
  const manifest = backupManifestSchema.parse(JSON.parse(plain));

  const result = await applyManifest(db, manifest);
  console.log(
    JSON.stringify({
      service: "chaste-restore",
      ok: true,
      organizationId: manifest.organizationId,
      exportedAt: manifest.exportedAt,
      ...result,
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
