# Backup, Export & Restore

Encrypted, org-scoped snapshots delivered through an object-store abstraction —
the same adapter pattern as email (`EmailAdapter`). The worker is the only
writer of stored artifacts; the UI and AI both go through commands.

## Data flow

```
core.backup.create ──► backups(queued) ──► worker.flushBackupJobs()
    └─► snapshotOrganization(db, orgId)         │
        └─► manifest (chaste-backup.v1)         │
        └─► checksum (sha256)                   │
        └─► encrypt (AES-256-GCM)               │
        └─► store.put(key, payload)             ▼
                                    backups(success|failed)
core.backup.restore ──► store.get(key) ──► decrypt ──► validate ──► applyManifest
```

## Manifest

- `schema: "chaste-backup.v1"` — zod-validated at restore.
- `tables: { <logical>: rows[] }` — only org-scoped tables; `organizations`
  included so a backup can be restored into a fresh environment (org row is
  upserted).
- Global reference data is excluded: `outbox_events` (would replay side
  effects), `audit_log` (append-only), `capability_catalog_items`,
  `marketplace_listings`, `ai_wakes`.
- Join tables (`user_roles`, `role_permissions`, `user_branch_access`,
  `chat_messages`, `msg_thread_members`, `msg_reads`, `acc_journal_lines`,
  `mfg_bom_lines`) resolve org membership through their parent table.

## Encryption

- AES-256-GCM via Node `crypto`; key = `CHASTE_BACKUP_KEY` (32 bytes hex).
- Each blob carries a `keyId` (sha256 prefix). Restore refuses blobs whose key
  id differs, so a rotated key fails loudly instead of corrupting data.
- Restore is a per-row upsert (`on conflict (id) do update`), so it is
  idempotent and safe to re-run.

## Object store

| Provider | Env | Notes |
|---|---|---|
| s3 | `CHASTE_S3_BUCKET` + `CHASTE_S3_ACCESS_KEY_ID` + `CHASTE_S3_SECRET_ACCESS_KEY` (+ `CHASTE_S3_REGION`, `CHASTE_S3_ENDPOINT`, `CHASTE_S3_SESSION_TOKEN`) | Minimal SigV4 client, works with AWS and S3-compatible endpoints (MinIO, R2). |
| local | `CHASTE_BACKUP_DIR` | Filesystem store for dev / single box. |
| none | — | Fails jobs with a clear configuration error. |

Precedence: s3 > local > none (mirrors `createEmailAdapter`).

## Commands / queries (all org-scoped, permission-gated)

| Name | Kind | Permission |
|---|---|---|
| `core.backup.create` | command | `core.backup.manage` |
| `core.backup.restore` | command | `core.backup.manage` |
| `core.backup.list` | query | `core.backup.read` |
| `core.backup.provider.status` | query | `core.backup.read` |

`core.backup.provider.status` reports provider + `encryptionConfigured` only —
never secrets.

## CLI restore

```bash
pnpm --filter @chaste/worker restore --file ./backup.json.enc
pnpm --filter @chaste/worker restore --store orgs/<orgId>/backups/<id>.json.enc
```

Requires `DATABASE_URL` and `CHASTE_BACKUP_KEY`; `--store` additionally uses
the configured object store. Output is a JSON summary (`restoredTables`,
`rowCount`).

## Crash recovery

`flushBackupJobs` claims `queued → running`, then marks each job
`success|failed`. Jobs left `running` past the 10-minute lease are reclaimed to
`queued`, matching the email-outbox pattern.

## Deployment (per-provider)

See `docs/deploy/` — provider-specific guides (AWS, GCP, Azure, Fly, Render,
Railway, Supabase/Neon) with the same env contract as the rest of the app.
