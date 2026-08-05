# Configuration & secrets

## Principles

1. **Secrets never live in git** -- only `.env.example` placeholders.
2. **Runtime config is typed** -- `loadConfig()` in `@chaste/config` (Zod).
3. **Providers are config-driven** -- select via `CHASTE_AI_PROVIDER`; credentials from env.
4. **Org business policy is in PostgreSQL** -- autonomy level, module installs, RBAC.
5. **Web receives no secrets** -- only `NEXT_PUBLIC_API_URL`.

## Secret sources

| Environment | How secrets arrive |
|---|---|
| Local | `.env` (gitignored) |
| Docker / Compose | env_file / secrets |
| Kubernetes | Secret → env |
| Cloud | Parameter Store / Vault / Doppler → env |

The application **only reads environment variables**. It does not call cloud secret APIs directly (keeps the runtime portable).

## AI providers

| `CHASTE_AI_PROVIDER` | Credentials | Notes |
|---|---|---|
| `none` | -- | Deterministic rule planner only |
| `openai` | `OPENAI_API_KEY` | Official API |
| `openai_compatible` | key + `CHASTE_AI_BASE_URL` | Local gateways, proxies |
| `ollama` | optional | Local LLM packaging via Ollama HTTP API |

## Multi-region

- `CHASTE_REGION` -- this deployment’s region label
- `CHASTE_REGIONS` -- known regions (marketplace geo filter)
- Org row stores `region` for affinity

## Full autonomous mode

Requires:

1. Platform flag `CHASTE_ALLOW_FULL_AUTONOMOUS=true`
2. Org command `core.autonomy.set` with `acknowledgeFullAutonomous: true`
3. UI shows hard warning (legal responsibility remains with the organization)

## Email delivery

Outbound email flows through a transactional outbox and a pluggable adapter.
Adapter precedence: **Resend** > **SMTP** > **console** (dev no-op).

| Variable | Feature |
|---|---|
| `CHASTE_RESEND_API_KEY` + `CHASTE_RESEND_FROM` | Resend provider |
| `CHASTE_SMTP_HOST` / `PORT` / `SECURE` / `USER` / `PASS` / `FROM` | SMTP (nodemailer) |
| `CHASTE_EMAIL_FROM` | Shared from-address fallback |

See [specs/scheduling-and-comms.md](./specs/scheduling-and-comms.md) §5.

## Backups

Snapshots are encrypted (AES-256-GCM) and stored in an object store. Store
precedence: **S3-compatible** > **local dir** > **none**.

| Variable | Feature |
|---|---|
| `CHASTE_BACKUP_KEY` | 32-byte hex encryption key; restore refuses other keys |
| `CHASTE_S3_BUCKET` / `REGION` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` / `SESSION_TOKEN` / `ENDPOINT` | Object store |
| `CHASTE_BACKUP_DIR` | Local filesystem store (dev) |

See [specs/backup-and-deploy.md](./specs/backup-and-deploy.md).

## Messaging & Buzz bridge

Internal messaging needs no configuration. Outbound delivery to external chat
services is opt-in:

| Variable | Feature |
|---|---|
| `CHASTE_BUZZ_WEBHOOK_SECRET` | Enables the Buzz bridge; shared HMAC secret for inbound webhooks |
| `CHASTE_BUZZ_OUTBOUND_WEBHOOK_URL` | Where worker-pushed events are delivered |

With no `CHASTE_BUZZ_WEBHOOK_SECRET`, the bridge is disabled and outbound calls
return `503 BUZZ_NOT_CONFIGURED`. See [specs/messaging-and-buzz.md](./specs/messaging-and-buzz.md).
