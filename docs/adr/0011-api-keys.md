# ADR 0011 — Org-scoped API keys as first-class machine credentials

## Status

Accepted (2026-08-08)

## Context

The platform is API-first: `apps/web` is "just an API client", AI executes
through the same command/query bus as humans, and the roadmap (marketplace /
gap-ticket → extensions) implies third-party integrations calling
`POST /api/v1/commands/:name` on behalf of an organization.

Before this ADR there was exactly **one credential class**: the per-user bearer
token (`users.auth_token`, hashed at rest, resolved by `resolveUserByToken`).
Permissions are role-derived only; a token carries no scope of its own. That
forced every non-human caller to either hold a human's session token or share
the single static Buzz webhook secret. It also blocked audit questions like
"which integration did this?" — only "which user's token leaked?" was answerable.

## Decision

Introduce **org-scoped API keys** as a distinct identity class:

- New `api_keys` table (org-owned). Columns: `id`, `organizationId`,
  `name`, `description`, `hashedSecret` (SHA-256, raw secret returned **once**
  at creation), `prefix` (display-only), `scopes` (text[]), `status`
  (`active`/`revoked`), `createdByUserId`, `expiresAt`, `lastUsedAt`,
  `createdAt`.
- Lifecycle commands in `@chaste/module-identity` (permission
  `core.apikey.manage`): `core.apikey.create`, `core.apikey.revoke`,
  `core.apikey.rotate`; read query `core.apikey.list`
  (`core.apikey.read`).
- **Scopes stand alone** — a key's effective permissions are exactly its
  declared scopes (validated to be a subset of `PERMISSION_CATALOG` at
  creation). They do not merge with the creator's roles, so a key can never
  exceed its declared scope no matter what the creator can do.
- HTTP auth: `X-Api-Key: <secret>` resolves to an `Actor` with
  `kind: "api_key"`, `clientId: <apiKeyId>`, and `permissions = scopes`.
  Audit entries written under that actor get `actorKind: "api_key"`.
- Lifecycle hardening from day one: hash-at-rest, per-key `expiresAt`,
  soft `revoked` status, rotation (old secret dies immediately), and
  `lastUsedAt` tracking. Invalid/revoked/expired keys are indistinguishable
  from "no credential" to callers (401), and never fall through to the
  bootstrap-admin fallback.

## Backward compatibility

- User bearer auth is unchanged (`Authorization: Bearer` still resolves users).
- API keys are a new credential surface; no existing caller changes.
- `core.user.invite` / `core.user.create` results are unchanged; their tokens
  additionally carry a `tokenExpiresAt` so bearer tokens now expire (F5).

## Consequences

- Third-party/ISV integrations get least-privilege, revocable access with clean
  audit attribution — the prerequisite for the marketplace/extension roadmap.
- The Buzz static webhook secret can later be migrated onto this model
  (one key per integration) rather than remaining a special case.
- Operators must manage key lifecycle (rotation, expiry) — surfaced through the
  same command bus, so humans and AI stay on one path.
