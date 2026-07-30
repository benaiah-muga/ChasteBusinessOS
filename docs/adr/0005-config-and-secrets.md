# ADR 0005: Configuration and secrets

## Status

Accepted

## Context

The platform needs secrets (DB, AI keys), infrastructure config, and org policy without tight coupling to a single cloud vendor.

## Decision

1. **Secrets and infrastructure** — environment variables only, validated by `@chaste/config` (Zod).
2. **Providers** — selected by config (`CHASTE_AI_PROVIDER`); implementations behind interfaces.
3. **Org policy** — PostgreSQL (autonomy, RBAC, module installs).
4. **Local LLM** — Ollama HTTP provider for self-hosted models.
5. **Web** — no secrets; HTTP API client only.

## Consequences

- Portable across secret managers
- Fail-fast invalid config
- Clear separation of secret vs business data
