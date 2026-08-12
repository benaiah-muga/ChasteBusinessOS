# Deployment

ChasteBusinessOS ships as four container images built from a single
multi-target [`Dockerfile`](../../Dockerfile). The deployment contract is the
same everywhere: a PostgreSQL database, an optional Redis, and the environment
variables documented in [`.env.example`](../../.env.example) and
[`docs/configuration.md`](../configuration.md).

## Images

| Target    | Image              | Runs                                                      |
| --------- | ------------------ | --------------------------------------------------------- |
| `migrate` | one-shot job       | Applies schema migrations (`dist/migrate.js`), then exits |
| `api`     | HTTP service       | Fastify API on `:3001` (boots with `node dist/index.js`)  |
| `web`     | HTTP service       | Next.js on `:3000` (browser + SSR API client)             |
| `worker`  | background service | Outbox processor, email/backup job loops, Buzz bridge     |

Build order per app: a `node:22-slim` base installs the frozen pnpm workspace
once, `turbo` compiles only the target's dependency graph, and
`pnpm deploy --prod` produces a self-contained tree with workspace `dist`
output inlined. No build tools ship in runtime images.

### Prebuilt images (GHCR)

Released images are public on GitHub Container Registry — no Docker Hub account
needed:

```bash
docker pull ghcr.io/benaiah-muga/chastebusinessos:api-v0.1.0
docker pull ghcr.io/benaiah-muga/chastebusinessos:web-v0.1.0
docker pull ghcr.io/benaiah-muga/chastebusinessos:worker-v0.1.0
docker pull ghcr.io/benaiah-muga/chastebusinessos:migrate-v0.1.0
```

Each image also gets a `-latest` tag. To build yourself instead:

```bash
docker build --target migrate -t chaste/migrate:0.1.0 .
docker build --target api     -t chaste/api:0.1.0 .
docker build --target web     -t chaste/web:0.1.0 .
docker build --target worker  -t chaste/worker:0.1.0 .
```

## Service wiring

1. **migrate** first, against an empty/upgrading database.
2. **api** and **worker** start only after migrate succeeds.
3. **web** starts after api is healthy; it talks to the api over HTTP.

`api` and `worker` both read `DATABASE_URL` and drain the same transactional
outbox; running exactly one worker replica is required until a queue-based
scale-out is introduced (Redis is wired but not yet load-bearing for outbox).

## Environment contract

Required everywhere (fail closed — no shipped defaults):

| Variable                                                       | Notes                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                                                 | `postgres://…` — must reach a `pgvector/pgvector:pg16`-compatible DB        |
| `CHASTE_SESSION_SECRET`                                        | ≥16 chars, HMAC session signing. Rotate via token expiry                    |
| `POSTGRES_PASSWORD` \| `REDIS_PASSWORD`                        | DB/cache credentials — the prod Compose requires them (`:?`)                |
| `CHASTE_BOOTSTRAP`                                             | `false` by default; set `true` + `CHASTE_ADMIN_TOKEN` on first boot         |
| `CHASTE_ADMIN_EMAIL` / `CHASTE_ADMIN_NAME` / `CHASTE_ORG_NAME` | bootstrap identity                                                          |
| `CHASTE_ALLOW_ANON_ADMIN`                                      | dev-only "no token ⇒ bootstrap admin" fallback; **production forces false** |
| `CHASTE_ADMIN_TOKEN`                                           | static bootstrap-admin credential (≥16 chars), stored hashed at rest        |
| `CHASTE_SESSION_TOKEN_TTL`                                     | bearer token TTL in seconds (default 30 days)                               |

Optional (feature-dependent):

| Variable                                                                          | Feature                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------- |
| `CHASTE_AI_PROVIDER` + `OPENAI_API_KEY` / `CHASTE_AI_BASE_URL` / `NVIDIA_API_KEY` | AI orchestration                             |
| `CHASTE_RESEND_API_KEY` + `CHASTE_RESEND_FROM`                                    | outbound email via Resend                    |
| `CHASTE_SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM`                                    | outbound email via SMTP                      |
| `CHASTE_BACKUP_KEY` (32-byte hex)                                                 | backup/restore encryption                    |
| `CHASTE_S3_BUCKET`/`REGION`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`                   | backup object store                          |
| `CHASTE_BACKUP_DIR`                                                               | backup local-store fallback (mount a volume) |
| `CHASTE_WEBHOOK_SECRET` / `CHASTE_BUZZ_*`                                         | Buzz bridge inbound                          |
| `CHASTE_REGION` / `CHASTE_REGIONS`                                                | multi-region labels                          |

Precedence rules: email adapter prefers Resend, then SMTP, then console.
Backup object store prefers S3, then local dir, then none.

## Quick start: single host with Docker Compose

```bash
export CHASTE_SESSION_SECRET="$(openssl rand -hex 24)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export REDIS_PASSWORD="$(openssl rand -hex 16)"
export CHASTE_BACKUP_KEY="$(openssl rand -hex 32)"
# first boot only:
export CHASTE_BOOTSTRAP=true
export CHASTE_ADMIN_TOKEN="$(openssl rand -hex 24)"
export CHASTE_ADMIN_EMAIL=admin@example.com
docker compose -f docker-compose.prod.yml up -d --build
```

The Compose file fails closed: it refuses to start without
`CHASTE_SESSION_SECRET`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD`, and the
containers run as the non-root `node` user (F10 remediation).

- API → http://localhost:3001/health
- Web → http://localhost:3000

Overrides for TLS/reverse proxy: set `API_URL`, `WEB_ORIGIN`, and
`NEXT_PUBLIC_API_URL` to the public HTTPS origins. `WEB_ORIGIN` is the CORS
allow-list origin of the web app; `API_URL` is the public origin of the API.

## Private overlay mesh (Headscale + Tailscale clients) — ADR 0012

An optional second security layer: a fully self-hosted private network. All
containers run as the non-root `node` user; the mesh keeps every service —
including Postgres and Redis, which never publish host ports — reachable only
from authenticated, ACL-approved mesh peers.

```bash
# 1. Start the control plane + its own node:
docker compose -f docker-compose.prod.yml --profile mesh up -d headscale

# 2. Create a user and a preauth key (24h window):
docker compose -f docker-compose.prod.yml --profile mesh exec headscale \
  headscale users create chaste
docker compose -f docker-compose.prod.yml --profile mesh exec headscale \
  headscale preauthkeys create --user chaste --reusable --expiration 24h

# 3. Re-run with the key (nodes join on boot) and hide host ports:
export TAILSCALE_AUTH_KEY="$(the-key-from-step-2)"
export API_BIND=          # empty → stop publishing :3001 to the host
export WEB_BIND=          # empty → stop publishing :3000 to the host
docker compose -f docker-compose.prod.yml --profile mesh up -d
```

Nodes (`api`, `web`, `worker`) join the tailnet via the `tailscale/tailscale`
sidecars that share their network namespaces (`network_mode: service:…`), so
your own devices (and future multi-host nodes) reach them at tailnet IPs.
Outbound service ACLs are defined in `deploy/mesh/acl.json`
(`tag:chaste-api` ⇄ db/cache, `tag:chaste-worker` ⇄ db/cache, operator ⇄ app).
The Headscale control plane config lives in `deploy/mesh/config.yaml`; its
`server_url` must be the address nodes can actually reach (set it to your
host's tailnet/static IP if clients are remote).

> The mesh is **infrastructure only** and does not replace app-level
> authentication; it complements RBAC + API keys (see `docs/adr/0012-headscale-overlay-network.md`).

## Platform guides

| Provider                                                   | Notes                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [AWS](aws.md)                                              | ECS Fargate or EKS; RDS Postgres; S3 backup store; ALB + ACM |
| [Google Cloud](gcp.md)                                     | Cloud Run jobs + services; Cloud SQL; Cloud Storage          |
| [Azure](azure.md)                                          | Container Apps; Azure Database for PostgreSQL; Blob storage  |
| [Fly.io](fly-io.md)                                        | `fly.toml`, machines; optional Upstash Redis                 |
| [Render](render.md)                                        | Web Services + one-off jobs; managed Postgres                |
| [Railway](railway.md)                                      | services + a pre-deploy `migrate` command; managed Postgres  |
| [Managed Postgres (Supabase / Neon)](managed-databases.md) | BYO database only; run images anywhere                       |

## Backup & restore

Snapshots are encrypted (AES-256-GCM) with `CHASTE_BACKUP_KEY`. Create and
restore from the `/data` page or the `core.backup.*` commands. Object-store
uploads are written by the worker's backup job loop; restore reads directly
from the configured store. See [docs/specs/backup-and-deploy.md](../specs/backup-and-deploy.md).
