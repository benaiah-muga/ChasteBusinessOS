# Configuration & secrets

## Principles

1. **Secrets never live in git** — only `.env.example` placeholders.
2. **Runtime config is typed** — `loadConfig()` in `@chaste/config` (Zod).
3. **Providers are config-driven** — select via `CHASTE_AI_PROVIDER`; credentials from env.
4. **Org business policy is in PostgreSQL** — autonomy level, module installs, RBAC.
5. **Web receives no secrets** — only `NEXT_PUBLIC_API_URL`.

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
| `none` | — | Deterministic rule planner only |
| `openai` | `OPENAI_API_KEY` | Official API |
| `openai_compatible` | key + `CHASTE_AI_BASE_URL` | Local gateways, proxies |
| `ollama` | optional | Local LLM packaging via Ollama HTTP API |

## Multi-region

- `CHASTE_REGION` — this deployment’s region label
- `CHASTE_REGIONS` — known regions (marketplace geo filter)
- Org row stores `region` for affinity

## Full autonomous mode

Requires:

1. Platform flag `CHASTE_ALLOW_FULL_AUTONOMOUS=true`
2. Org command `core.autonomy.set` with `acknowledgeFullAutonomous: true`
3. UI shows hard warning (legal responsibility remains with the organization)
