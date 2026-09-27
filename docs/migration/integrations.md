# Integration trust-boundary inventory

This inventory records the current TypeScript behavior for integrations whose
credentials or external calls affect tenant data, agent authority, or identity.
It is a migration baseline, not a change in route or runtime ownership. The
repository's `graft` CLI was unavailable (`graft: command not found`), so these
entries use targeted source reads and cite the exact source spans.

## AI model providers and workspace credentials

**Current lifecycle.** With no `MODEL_PROVIDER`, the process-level default is
NVIDIA NIM. The adapter can also route to OpenRouter, Groq, Mistral, Z.ai,
OpenAI, or a custom OpenAI-compatible URL. `MODEL_PROVIDER` selects a process
default, while recognized model prefixes select a provider when no explicit
runtime provider config is passed. An explicit runtime config wins over the
model prefix. Workspace settings store provider, base URL, model roles, key
hint, and encrypted credential in
`organizations.settings.ai`; absent workspace settings fall back to environment
configuration. `GET /api/ai-config` returns provider metadata and whether a key
is configured, never the key. `POST` accepts a new key, retains the previous
key when omitted, or clears it explicitly, then invokes
`settings.configureAiProvider`. Runtime resolution decrypts the selected
workspace key for the provider client. Sources: `packages/ai/src/providers.ts:19-25,42-126,137-164`, `apps/web/src/server/ai-settings.ts:84-117,120-153,156-199`, `apps/web/src/app/api/ai-config/route.ts:15-21,27-60`.

**Tenant, permission, and secret boundary.** A resolved session supplies the
organization for reads and writes. Writes pass through the kernel capability,
which is classified `secret` and requires `iam.admin`; its inverse restores the
previous configuration. Environment keys are deployment-wide. Workspace keys
are encrypted with AES-256-GCM, using a SHA-256-derived key from
`AI_CONFIG_ENCRYPTION_KEY` or the `BETTER_AUTH_SECRET` fallback. Only a masked
hint is returned. Runtime configuration decrypts the key server-side and passes
it to provider client construction; the public response does not include it.
Sources:
`apps/web/src/server/ai-settings.ts:156-195`, `apps/web/src/server/ai-secrets.ts:3-23`, `packages/db/src/schema/index.ts:48-50`.

**Tests and proofs.** `packages/ai/src/providers.test.ts:35-83` covers routing,
prefix precedence, endpoint override, missing-key refusal, and explicit
workspace runtime configuration. Demo proofs use a configured provider key as
described in `README.md:134-147`. No dedicated saved-workspace-key rotation or
`/api/ai-config` authorization integration test was identified in the reviewed
test paths.

**Go parity.** Preserve environment and workspace precedence, provider names,
model-prefix overrides when no explicit runtime config is supplied, key
retention/clear semantics, encryption compatibility, key hints, and the
`iam.admin` governed write. Generate the UI contract for
provider IDs and model fields, while validating the request again in Go.

**Open questions.** The custom provider accepts any URL-shaped `baseUrl`, and
the custom client sends requests to it; decide the allowed outbound destination
policy before porting this setting. Define how encrypted values are re-keyed if
the encryption secret changes, since the fallback currently depends on
`BETTER_AUTH_SECRET`. Decide whether environment keys remain a deployment-level
fallback or move to a managed secret reference.

## Signed plugin manifests and marketplace installation

**Current lifecycle.** `@chaste/plugin-kit` validates manifest shape and risk
declarations, canonicalizes sorted object keys, hashes with SHA-256, and signs
or verifies the digest with Ed25519. `creator.verifyPlugin` is a read
capability. `creator.publishListing` re-verifies the signature, serializes
same-slug changes with an advisory lock, enforces publisher-org slug ownership,
and stores the listing as verified. Install is an `identity`-risk capability
with an uninstall inverse; it requires `platform.creator`, checks verified
status, verifies the signature again, and records the installing organization.
Browse reads verified listings and reports whether the current organization is
installed. Sources: `packages/plugin-kit/src/index.ts:13-38,42-57,69-119`, `modules/creator/src/index.ts:187-205,208-274,305-349,385-430`.

**Tenant, permission, and stored state.** Listing records contain manifest,
signature, publisher public key, capability IDs, publisher organization, status,
and an `installedByOrgIds` array. The marketplace table is intentionally
public-readable under RLS, while publish/retract operations are publisher-org
scoped and install/uninstall are attributed to the current actor organization.
The marketplace route requires a resolved organization. Its `GET` directly
selects up to 100 rows without the `creator.listMarketplace` permission check,
includes statuses beyond `verified`, and returns `installedByOrgIds`. Its
`verify` action calls the pure verifier directly after session/org resolution,
without the `creator.verifyPlugin` capability permission check. Publish,
install, and uninstall use the kernel executor. Sources:
`packages/db/src/schema/index.ts:2243-2272`, `packages/db/drizzle/0014_rls_everywhere.sql:110-115`, `apps/web/src/app/api/marketplace/route.ts:8-37,40-84`, `modules/creator/src/index.ts:187-205`.

**Scope and tests/proofs.** The stored marketplace object is a signed manifest
and installation ledger. The reviewed schema and capability path do not store
or execute plugin package code. `packages/plugin-kit/src/index.test.ts:23-94`
covers canonicalization, mutation, wrong-key, malformed-key, schema, and risk
checks. `scripts/nl-tasks.ts:534-572` exercises invalid-signature rejection,
publish, and identity-gated install through the API.

**Go parity.** Keep canonical bytes and digest identical, reject unsigned or
tampered manifests, retain slug ownership and status checks, re-verify at
install time, preserve installation state in the existing database, and keep
installation behind the same identity approval and permission path. Do not
introduce executable plugin loading as part of the port. The migration target
also calls out plugin signing and install state explicitly in
`docs/REACT_GO_MIGRATION_PLAN.md:150-153,168-172`.

**Open questions.** A listing proves that the supplied key signed the
manifest, but no external publisher-key registry or key-rotation protocol is
visible in the reviewed path. Confirm whether self-signed publisher identity
is the intended trust model. Confirm whether marketplace installation remains
record-only; there is no artifact URL or runtime package in the reviewed table.
The API returns statuses beyond `verified` and selects `installedByOrgIds`
with every listing, while the capability output only reports verified rows
and `installedHere`; confirm whether this broader visibility and the full
installer-org list are intentional (`apps/web/src/app/api/marketplace/route.ts:13-37`, `modules/creator/src/index.ts:397-428`).

## Coding-agent discovery, personal connections, and dispatch

**Discovery lifecycle.** Read-only detection scans PATH and known user config
paths for OpenCode, Claude Code, Codex, Kilo, Aider, and Gemini CLI, and probes
versions for found binaries. The Creator endpoint reports detection and
installation guidance; it does not install packages. Sources:
`packages/ai/src/coding-agents.ts:22-34,38-54,76-114`, `apps/web/src/server/creator-agent.ts:14-20,80-103`, `apps/web/src/app/api/creator/agent/route.ts:5-16`.

**Connection lifecycle and state.** The personal connection API supports
Codex device login and OpenCode server credentials. Codex login runs the local
CLI with an org-and-user-specific `CODEX_HOME`; login state and credentials
remain in that private server-side directory, while the database stores
connection metadata. OpenCode requires a healthy remote server with a
connected model provider, then stores its endpoint, model ID, and encrypted
username/password in `coding_agent_connections`. Disconnect logs out and
removes the Codex home, or clears the encrypted OpenCode credential and marks
the row disconnected. Sources:
`apps/web/src/server/coding-agent-connections.ts:69-77,309-369,380-463,490-536`, `packages/db/src/schema/index.ts:68-95`, `packages/db/drizzle/0074_steep_miek.sql:1-22`.

**Tenant, permission, and network boundary.** The API binds connection reads
and changes to the resolved `(orgId, userId)` and marks responses private and
non-cacheable. The table has organization RLS; handlers also filter by the
owning user. OpenCode production endpoints must use public HTTPS, reject URL
credentials/query/hash and private-network DNS answers, and requests use
authenticated transport without following redirects. Sources:
`apps/web/src/app/api/ai-connections/route.ts:22-74`, `apps/web/src/server/coding-agent-connections.ts:98-155,158-206,253-273`, `packages/db/drizzle/0078_calm_dinosaurs.sql:1-5`.

**Dispatch boundary.** Only a connected user's default connection is selected
for runtime routing. Codex runs ephemeral in a read-only sandbox with shell and
other broad features disabled; OpenCode tools are restricted to the Chaste MCP
tool names. The signed MCP grant carries organization, user, connection,
optional session, and allowed tool names. The MCP endpoint rechecks connection
status, membership, and session, reconstructs the agent actor, intersects the
grant with currently available capabilities, rate-limits calls, records session
events, and executes through the governed capability executor. Sources:
`apps/web/src/server/ai-settings.ts:120-143`, `apps/web/src/server/coding-agent-adapter.ts:124-137,218-258,282-359,363-385`, `apps/web/src/server/coding-agent-connections.ts:222-250,275-307`, `apps/web/src/app/api/ai-tools/mcp/route.ts:34-40,60-110,111-141`.

**Tests and proofs.** `packages/ai/src/coding-agents.test.ts:30-79` covers fake
PATH, config-only detection, version probing, and fixture-home isolation.
`apps/web/src/server/coding-agent-connections.test.ts:8-93` covers signed grant
expiry/tampering, endpoint rejection, authenticated requests, Codex sandbox
arguments, and event parsing. The reviewed tests do not show a complete
connected-account-to-MCP execution proof.

**Go parity.** Preserve detection semantics where Creator mode still needs
server-local probes; preserve each user's provider selection and server-side
credential location; retain OpenCode egress restrictions; and retain signed,
allowlisted tool grants plus the live membership, connection, session, permission,
policy, approval, rate-limit, and audit checks at dispatch. Do not allow a model
or remote coding agent to bypass the shared capability executor. The target
contract is stated in `docs/REACT_GO_MIGRATION_PLAN.md:142-146,168,172`.

**Open questions.** Discovery uses the application host's home and PATH, while
personal connection settings are per user; decide whether the UI should label
these as host-wide inventory. Confirm how Codex's user-owned auth files move
when workers run in Go containers, and how credentials are migrated without
changing their encryption key. The database RLS policy is org-scoped, so the
Go handlers must preserve the additional owner-user filter.

## Inbound routine webhooks and durable agent runs

**Current lifecycle.** Routine creation can request a webhook, generating a
`crypto.randomUUID()` token stored on the routine row. The authenticated
routines API returns its URL on create and list. The list capability omits the
token, as the route comment states, but the create capability returns the raw
token. The token route
accepts both POST and GET without session authentication, checks that the token
exists and the routine is enabled, then enqueues a durable run. The worker
creates a replayable agent session and executes with a fixed system permission
set. Sources: `modules/routines/src/index.ts:50-73,101-125`, `apps/web/src/app/api/routines/route.ts:36-59,62-110`, `apps/web/src/app/api/routines/webhook/[token]/route.ts:6-26`, `apps/web/src/server/routines.ts:30-50,146-153,159-247,289-303`, `packages/db/src/schema/index.ts:2670-2708`.

**Tenant, permission, and stored state.** The token itself is the bearer
authority for triggering one enabled routine; it is stored as plaintext in
`routines.webhook_token` and appears in the authenticated org's returned URL.
Routine creation requires `routines.write`. Triggering only queues work; the
run actor has an explicit read-and-messaging permission list and the prompt
forbids financial create/post/approve actions. A support-ticket sink directly
inserts tickets for the runner as a documented infrastructure exception.
Sources: `modules/routines/src/index.ts:50-60,101-125`, `apps/web/src/server/routines.ts:30-50,149-153,225-235,294-302`.

**Tests and proofs.** `scripts/gates/routines-e2e.ts:55-85,87-129` creates a
webhook routine, calls its unauthenticated URL, runs the real worker, and checks
job/session/notification completion. `apps/web/src/server/routines.test.ts:39-75`
covers scheduled occurrence claim races and cancellation, but not token
rotation or invalid-token rate limits.

**Go parity.** Keep token-to-routine lookup, disabled-routine refusal,
authenticated URL disclosure, queue receipts, scheduled and webhook triggers,
fixed least-privilege actor permissions, replay events, and the existing job
rows. Route every allowed effect through Go's same governed executor and
preserve the documented ticket exception until separately resolved. The plan
requires Go ownership for webhook and worker paths at
`docs/REACT_GO_MIGRATION_PLAN.md:125-128,147-149,172-173`.

**Open questions.** No explicit webhook-token rotation endpoint, per-token
expiry, or route-level rate limiter is visible in the reviewed path; the route
comment relies on queue attempts and worker pacing. GET currently triggers the
same work as POST. Decide whether to retain these semantics or version them
separately. Agent invocation of `routines.create` does expose `webhookToken` to
the model: the kernel serializes successful capability output into the tool
result and sends that result in the next model message, which is sent to the
configured provider or coding-agent endpoint. The list capability omits it, so
its route comment is accurate for listing but not for creation. Confirm whether
this exposure is intended before preserving it in Go
(`modules/routines/src/index.ts:61-67`, `packages/kernel/src/loop.ts:290-296`, `apps/web/src/app/api/routines/route.ts:44-58,103-108`). Confirm how to preserve stored plaintext webhook tokens and existing external URLs during deployment cutover.

## Outbound notification and email delivery

**Current lifecycle.** Approval and ticket notifications write durable outbox
intents when `NOTIFICATION_WEBHOOK_URL` and/or SMTP environment settings are
configured. A worker claims each row with a lease and fencing token, calls the
provider, then records sent, retryable, failed, or unknown status. A 429
webhook response is retried, other 4xx responses fail, and uncertain outcomes are marked
unknown for explicit reconciliation instead of a blind resend. Email delivery
uses SMTP environment credentials. Sources:
`apps/web/src/server/kernel.ts:190-198,233-295`, `apps/web/src/server/outbox.ts:7-31,55-75,92-133,135-198,209-263,282-342`, `packages/db/src/schema/index.ts:2776-2810`.

**Tenant, permission, and stored state.** Each intent is stored with `orgId`,
dedupe key, provider operation ID, payload, attempts, lease/fencing state,
receipt, and status. Webhook URL is deployment-level configuration, not an
org-specific connection. SMTP host, user, password, sender, and target are
environment configuration; the provider password is not stored in each outbox
row. Message bodies and webhook payloads are stored in the outbox until
delivery/reconciliation. Marketing email checks customer membership in the
same org and rechecks opt-out/deactivation/address immediately before sending.
Sources: `apps/web/src/server/kernel.ts:246-264,276-295`, `apps/web/src/server/outbox.ts:265-279,310-337`, `packages/db/drizzle/0039_chubby_boomer.sql:1-29`.

**Tests and proofs.** `apps/web/src/server/outbox.test.ts:38-85` covers
dedupe, provider acknowledgment, unknown outcomes, and explicit reconciliation;
`apps/web/src/server/outbox.test.ts:87-143` covers approval notification fan-out and the
dispatch-time marketing opt-out check. Worker crash/lease coverage also lives
in `apps/web/src/server/worker-kill.test.ts:22-34,232-285`.

**Go parity.** Reuse the same outbox rows and operation IDs; preserve claim,
lease renewal, fencing, retry timing, unknown-result reconciliation, payload
shape, and org scoping. Keep global deployment endpoints and SMTP credentials
as secret references rather than copying them into tenant records. The plan
specifies these worker guarantees at
`docs/REACT_GO_MIGRATION_PLAN.md:147-149,172-173`.

**Open questions.** The outbound webhook payload accepts a URL-shaped endpoint
and the worker fetches it directly; the reviewed path shows no destination
allowlist or tenant-specific webhook administration. Preserve this as the
current behavior in the inventory, and decide the egress policy before moving
the worker. Confirm retention and redaction policy for pending payloads and
provider receipts.

## SSO metadata and SCIM provisioning

**Current lifecycle.** SSO CRUD stores per-org IdP metadata: protocol, entity
ID, SSO URL, optional public certificate, domain routing, and active/disabled
status. The route describes actual assertion exchange as an external
better-auth SSO plugin responsibility. SCIM token management creates a
random bearer token returned once, stores only its SHA-256 hash, defaults to
90-day expiry (configurable from 1 to 365 days), and supports deactivation.
The `Users` collection endpoints authenticate by that token, rate-limit by
source IP, and scope provisioning to the token's org. Provisioning creates a
global user as needed and grants org membership only. The item DELETE removes
the member's org authority through `deactivateMember`, including role grants
and pending invitations, while protecting the org's last owner; the global
user row remains. Sources:
`apps/web/src/app/api/team/sso/route.ts:7-11,14-33,36-88`, `packages/db/src/schema/index.ts:2189-2241`, `apps/web/src/app/api/scim/tokens/route.ts:8-24,27-72`, `apps/web/src/app/api/scim/v2/Users/route.ts:7-48,60-118`, `apps/web/src/app/api/scim/v2/Users/[id]/route.ts:14-42`.

**Tenant and permission boundary.** SSO configuration GET/POST/DELETE requires
an authenticated org and `iam.admin`; table reads and writes include that org.
SCIM token creation/deactivation requires `iam.admin`; listing token metadata
requires an authenticated org session but does not visibly check `iam.admin`.
Provisioning calls use the bearer secret and resolved token org, not a browser
session. Creating an SCIM member grants membership only, leaving role
assignment to the governed human-approved identity flow. The raw SCIM token is
returned only at creation; only the hash, org, label, expiry, activity, and
last-use timestamp persist. Sources:
`apps/web/src/app/api/team/sso/route.ts:14-19,36-40,75-87`, `apps/web/src/app/api/scim/tokens/route.ts:10-24,27-56,59-71`, `apps/web/src/app/api/scim/v2/Users/route.ts:27-47,109-118`, `apps/web/src/app/api/scim/v2/Users/[id]/route.ts:15-42`.

**Tests and proofs.** `apps/web/src/server/scim-tokens.test.ts:63-125` covers
expiry, invalid windows, rotation, and expired-token refusal through the
`/Users` collection handler; the cited tests do not exercise `/Users/{id}`.
The natural-language integration suite covers SCIM provision/deactivate and
SSO metadata registration in `scripts/nl-tasks.ts:574-600`. The reviewed files
contain no SAML/OIDC assertion-exchange test.

**Go parity.** Preserve existing Better Auth users, sessions, cookies, verified
identity binding, SSO metadata, SCIM hashes, configured expiry and last-used
fields, membership behavior, and endpoint wire responses. Keep the current
collection-route expiry/rate-limit behavior, and resolve the item-route gap
explicitly before claiming uniform token expiry parity. Do not treat SSO CRUD as
proof that federation login is active. The migration plan calls for auth
compatibility and delaying auth ownership cutover until credential, cookie,
verified identity, org selection, and permission proofs pass at
`docs/REACT_GO_MIGRATION_PLAN.md:174,216-220`.

**Open questions.** The item endpoints `GET /Users/{id}` and `DELETE /Users/{id}`
check the active token hash but visibly omit the expiry check and source-IP
rate limit used by the collection handler. `GET /Users/{id}` also does not
update `lastUsedAt` (`apps/web/src/app/api/scim/v2/Users/[id]/route.ts:15-28,45-72`, `apps/web/src/app/api/scim/v2/Users/route.ts:27-47`). Confirm intended expiry and throttling behavior before Go parity. The collection route also exports a DELETE handler that derives the user ID from the final URL segment, while the item route has its own DELETE lifecycle; confirm the supported contract (`apps/web/src/app/api/scim/v2/Users/route.ts:121-135`, `apps/web/src/app/api/scim/v2/Users/[id]/route.ts:14-42`).

The SSO route comment references an SSO plugin, but the reviewed
`apps/web/src/server/auth.ts:7-48` configures email/password and no SSO plugin.
Confirm whether SAML/OIDC assertion exchange is implemented in a different
deployment component or whether current SSO is metadata-only. SCIM GET token
listing requires a session and org but does not visibly require `iam.admin`,
unlike create and revoke.

## Cross-cutting Go migration requirements

The target keeps the current database and treats integration parity as part of
the cutover gate. Go must preserve the governed path for human, agent, webhook,
and worker effects, RLS tenant scope, existing URLs and response shapes,
provider and coding-agent routing, secret references, outbox guarantees, and
plugin install integrity. These requirements are explicit in
`docs/REACT_GO_MIGRATION_PLAN.md:125-153,168-174,216-220`. No production
integration ownership is changed by this inventory.
