# Using Supabase or Neon as the database

Supabase and Neon both offer managed PostgreSQL 16 and fit the platform's
`DATABASE_URL` contract with zero extra glue. Run the `api` / `web` /
`worker` images anywhere else (the [compose](./README.md) quick start, ECS,
Cloud Run, Fly, Render, Railway…); only the database is hosted.

## Connection string

Both providers publish a `postgres://…` connection string. Set it as
`DATABASE_URL` on `api`, `worker`, and the one-shot `migrate` service.

- **Neon**: use the **pooled** connection string (`-pooler` hostname, port 5432) for the services and the direct connection for `migrate` if you hit
  connection limits.
- **Supabase**: use the connection string from _Database → Connection
  settings_; add `?sslmode=require`.

SSL is handled by the `postgres` driver automatically for both.

## Migrations

Run the `migrate` image once pointing at the managed DB:

```bash
docker run --rm \
  -e DATABASE_URL='postgres://…' \
  chaste/migrate:0.4.0
```

The `CREATE TABLE … IF NOT EXISTS` DDL is idempotent; re-running after
upgrades applies the missing schema. PITR/restores are a provider feature,
independent of the platform's snapshot backup.

## Notes

- The worker's outbox consumer polls Postgres directly; there is no extra
  worker for these providers.
- Neon serverless driver is **not** used — the plain `postgres` driver works
  with both pooled and direct endpoints.
- Keep `CHASTE_S3_*` / `CHASTE_BACKUP_KEY` on the `worker` so platform
  snapshots are encrypted and durable; provider backups cover the DB, not the
  application snapshot format.
