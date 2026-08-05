# Deploying on Fly.io

Fly machines map cleanly to the four images. Use a managed Postgres
(`fly postgres create`) and optionally Upstash Redis (not yet load-bearing).

## 1. Add a Postgres cluster

```bash
fly postgres create --name chaste-pg --region ams
fly postgres attach chaste-pg   # prints DATABASE_URL
```

## 2. App config

Create one `fly.toml` per image (or use `fly launch` then edit). Example for
the api:

```toml
app = "chaste-api"
primary_region = "ams"

[build]
  dockerfile = "Dockerfile"
  target = "api"

[env]
  NODE_ENV = "production"
  PORT = "3001"
  API_URL = "https://chaste-api.fly.dev"
  WEB_ORIGIN = "https://chaste-web.fly.dev"
  CHASTE_BOOTSTRAP = "true"
  CHASTE_ORG_NAME = "Primary Organization"
  CHASTE_ADMIN_EMAIL = "admin@example.com"
  CHASTE_ADMIN_NAME = "System Admin"

[[services]]
  internal_port = 3001
  protocol = "tcp"
  [[services.ports]]
    port = 443
    handlers = ["tls"]
```

The worker has the same env minus the ports block, plus one replica:
`fly scale count 1`.

## 3. Secrets

```bash
fly secrets set \
  DATABASE_URL="$DATABASE_URL" \
  CHASTE_SESSION_SECRET="$(openssl rand -hex 24)" \
  CHASTE_BACKUP_KEY="$(openssl rand -hex 32)"
```

Add AI/email/S3 secrets only if you use those features.

## 4. Migrate (one-shot)

Give `migrate` its own app so it never scales:

```toml
# fly-migrate.toml — target = "migrate", no [[services]], no [build.dockerfile] services
app = "chaste-migrate"
primary_region = "ams"
[build]
  dockerfile = "Dockerfile"
  target = "migrate"
```

```bash
fly deploy -c fly-migrate.toml
fly run --detach -c fly-migrate.toml   # run once per deploy
```

## 5. Volumes for backups

If you use the local backup store instead of S3, attach a volume and set
`CHASTE_BACKUP_DIR=/data/backups`:

```bash
fly volumes create chaste_data --app chaste-worker --size 5
fly secrets set --app chaste-worker CHASTE_BACKUP_DIR=/data/backups
```

Prefer an S3-compatible bucket for durability.
