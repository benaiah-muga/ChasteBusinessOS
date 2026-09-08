# Setting up ChasteBusinessOS locally

This guide takes you from a clean machine to a running workspace. Pick one of
three database paths — **Docker**, **hosted Postgres**, or **native Postgres** —
then follow the common steps. You need a database, but you do *not* need Docker.

> **New here?** Read [ARCHITECTURE.md](./ARCHITECTURE.md) first (10 minutes). It
> explains the capability kernel, which makes the rest of the codebase legible.

---

## 0. What you need

| Tool | Version | Check | Notes |
|---|---|---|---|
| **Node.js** | 24 (CI runs 24; Next.js 16 requires ≥ 20.9) | `node -v` | |
| **pnpm** | 11 | `pnpm -v` | `corepack enable && corepack prepare pnpm@11.9.0 --activate` |
| **Git** | any recent | `git --version` | |
| **Postgres** | 16 **with pgvector** | — | one of the three paths below |
| **A model provider key** | — | — | **optional to boot**, see [§5](#5-optional-the-ai-provider-key) |

Everything else (TypeScript, Next.js, Drizzle, Vitest) is installed by
`pnpm install`.

### What pgvector is for

Org memory — the business description you write at onboarding, plus retrieved
context — is stored as embeddings and searched by vector similarity
(ADR 0008). Migration `0000` runs `CREATE EXTENSION IF NOT EXISTS "vector"`, so
the **extension must be installable** by whatever role you connect with. If that
fails, the very first migration fails, and the error looks unrelated.

---

## 1. Pick your database path

### Path A — Docker (quickest, ~1 minute)

Good if you have Docker and want a disposable database.

```sh
docker run -d --name chaste-pgvector \
  -e POSTGRES_PASSWORD=chaste_dev \
  -e POSTGRES_USER=chaste \
  -e POSTGRES_DB=chaste_os_v2 \
  -p 5433:5432 \
  pgvector/pgvector:pg16
```

Your connection string is the default in `.env.example`:

```
DATABASE_URL="postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2"
```

> Port **5433** on the host maps to 5432 in the container, so it won't collide
> with a Postgres you already run locally.

Stop, start, and remove:

```sh
docker stop chaste-pgvector && docker start chaste-pgvector   # pause/resume
docker rm -f chaste-pgvector                                  # throw it away
```

A `docker-compose.yml` is included if you prefer Compose:

```sh
docker compose up -d      # start
docker compose down       # stop (data persists in a named volume)
docker compose down -v    # stop and delete the data
```

### Path B — Hosted Postgres (no Docker at all)

Good if you can't or don't want to run containers. Any provider with
**pgvector** works; Neon, Supabase, Railway, and Render all support it.

1. Create a Postgres 16 database.
2. Enable pgvector — usually `CREATE EXTENSION IF NOT EXISTS vector;` in the
   provider's SQL console, or a toggle in their dashboard. On Supabase and Neon
   it is available by default.
3. Copy the connection string. Hosted providers require TLS, so keep
   `sslmode=require`:

```
DATABASE_URL="postgresql://user:password@host:5432/dbname?sslmode=require"
```

Trade-offs: no local install, and the database survives a wiped repo. Costs
nothing on free tiers, but latency is real and you need network access to
develop.

### Path C — Native Postgres on your machine

Good if you want no containers and no external dependency.

**macOS (Homebrew)**

```sh
brew install postgresql@16 pgvector
brew services start postgresql@16
```

**Debian / Ubuntu**

```sh
sudo apt install postgresql-16 postgresql-16-pgvector
sudo systemctl start postgresql
```

**Windows** — use the [Postgres installer](https://www.postgresql.org/download/windows/),
then build pgvector from source per its
[README](https://github.com/pgvector/pgvector#windows), or use WSL2 with the
Debian instructions.

Then create the role and database:

```sh
psql -U postgres <<'SQL'
CREATE ROLE chaste LOGIN PASSWORD 'chaste_dev';
CREATE DATABASE chaste_os_v2 OWNER chaste;
SQL

psql -U postgres -d chaste_os_v2 -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

```
DATABASE_URL="postgresql://chaste:chaste_dev@localhost:5432/chaste_os_v2"
```

Note the port is **5432** here, not 5433 — nothing is being mapped.

---

## 2. Install and configure

```sh
git clone https://github.com/benaiah-muga/ChasteBusinessOS.git
cd ChasteBusinessOS

pnpm install                      # installs every workspace package

cp .env.example .env              # then edit .env
```

Open `.env` and set two things:

```sh
# Your connection string from whichever path you chose above.
DATABASE_URL="postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2"

# Any long random string. This signs sessions — generate one with:
#   openssl rand -base64 32
BETTER_AUTH_SECRET=""
```

`.env` is gitignored. `.env.example` is committed and holds only placeholders.

---

## 3. Run the migrations

```sh
pnpm --filter @chaste/db db:migrate
```

You can skip this: the web server applies pending migrations once at boot
before serving requests, serialized across instances by a Postgres advisory
lock. Running it by hand just means you see errors sooner and in isolation.

A `pg_dump` snapshot is taken before every migration into
`packages/db/backups/` (newest 10 kept), so a bad migration is recoverable.
See the *Upgrading* section of [README.md](../README.md) for the restore
procedure and the `CHASTE_STRICT_MIGRATION_BACKUP` / `AUTO_MIGRATE_ON_BOOT`
controls.

---

## 4. Start the app

```sh
pnpm dev
```

Open <http://localhost:3000>. If port 3000 is taken, Next picks the next free
port and prints it — check the terminal.

Then:

1. **Create an account.** The sign-in screen has a *Create an account* toggle.
2. **Describe your business** at onboarding — a couple of sentences is enough.
   This seeds your chart of accounts, embeds the description into org memory,
   and makes you the owner.
3. **You're in.** Try the agent dock on any page.

### Verify it actually works

The demo scripts are executable specifications — if one fails, something is
genuinely wrong:

```sh
pnpm typecheck && pnpm lint && pnpm test   # the gate CI runs
pnpm demo:slice                            # invoice → gated payment → approval
pnpm demo:m5                               # POS session → sale → drawer variance
```

`demo:m5` needs no model key. `demo:slice` drives the real agent, so it needs
one. Full list in [README.md](../README.md#demo-proofs).

---

## 5. Optional: the AI provider key

**The app boots and most of the ERP works without a model key.** Accounting,
inventory, CRM, POS and the rest are deterministic code, not model calls. What
you lose without one:

| Works without a key | Needs a key |
|---|---|
| Sign-up, onboarding, all business modules | Agent chat and tool calls |
| Ledger postings, approvals, reports | `askYourBusiness`, `explainChange` narration |
| `demo:m5`, `demo:m9`, and other deterministic proofs | `demo:slice`, `demo:m7`, embedding-based memory search |

Onboarding degrades gracefully: if embedding fails, a zero vector is stored and
retrieval falls back to keyword search rather than erroring.

To enable the agent, add one provider to `.env`:

```sh
NVIDIA_API_KEY=""      # default; free tier at build.nvidia.com
# or set MODEL_PROVIDER to openrouter | groq | mistral | zai and supply that key
```

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_PNPM_OUTDATED_LOCKFILE` | A dependency changed without regenerating the lockfile | `pnpm install`, then commit `pnpm-lock.yaml` |
| `DATABASE_URL is not set` | `.env` missing or not copied | `cp .env.example .env` and set it |
| `ECONNREFUSED … :5432` | Postgres not running, or wrong port | Docker path uses **5433**; native uses **5432**. `docker ps` to confirm |
| `type "vector" does not exist` | pgvector not installed / role can't create extensions | `CREATE EXTENSION IF NOT EXISTS vector;` as superuser, or use the `pgvector/pgvector` image |
| `password authentication failed for user "chaste"` | Role doesn't exist or password mismatch | Recreate the role; a stale volume from an earlier run keeps old credentials — `docker compose down -v` |
| `Tenant or user not found` (Neon/Supabase) | Wrong host or branch string | Re-copy the connection string from the dashboard |
| Migrations hang | Another instance holds the advisory lock | Stop other dev servers; check `pg_stat_activity` |
| Port 3000 in use | | Next auto-selects the next free port — read the terminal output |
| Sign-up succeeds, then loops back to login | `BETTER_AUTH_SECRET` empty or changed | Set a stable secret, restart |
| `NVIDIA_API_KEY is not set` at runtime | No provider key | Expected without one — see [§5](#5-optional-the-ai-provider-key) |

**Still stuck?** The `packages/db` package has `db:studio` (Drizzle Studio) for
inspecting the schema, and `LOG_LEVEL=debug` in `.env` makes the server
verbose.

---

## 7. Day-to-day commands

| Task | Command |
|---|---|
| Start dev server | `pnpm dev` |
| Run the verification gate | `pnpm typecheck && pnpm lint && pnpm test` |
| Apply migrations | `pnpm --filter @chaste/db db:migrate` |
| Generate a migration after a schema change | `pnpm --filter @chaste/db db:generate` |
| Inspect the database | `pnpm --filter @chaste/db db:studio` |
| Run one milestone proof | `pnpm demo:m9 fulfillment` |
| Production build | `pnpm build && pnpm start` |
| Stop everything (Docker path) | `docker compose down` |

Before opening a PR, read [CONTRIBUTING.md](../CONTRIBUTING.md) — in particular
the [stacked PR rules](../CONTRIBUTING.md#stacked-pull-requests) and the rule
that a changed dependency means a regenerated lockfile in the same commit.
