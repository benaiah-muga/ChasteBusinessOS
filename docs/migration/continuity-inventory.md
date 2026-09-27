# Data, identity, governance, and proof continuity inventory

Status: Phase 0 source inventory. The Next.js application still owns
production requests and writes. No production traffic has moved to Go.

## Database and stored business data

- [`data-tables.json`](data-tables.json) is generated from
  [`packages/db/src/schema/index.ts`](../../packages/db/src/schema/index.ts)
  and records all 133 exported Drizzle tables with their source line. CI runs
  `pnpm migration:data:check` to catch source drift.
- Existing SQL history remains under `packages/db/drizzle/`. The runtime move
  does not require a database copy or schema rewrite. Continue using the same
  PostgreSQL database and rows, including Better Auth, business, audit, agent,
  worker, receipt, and integration records.
- Tenant reads and writes in the current web runtime use
  `withOrgContext`, which sets `app.org_id` transaction-locally
  ([`client.ts#L35-L56`](../../packages/db/src/client.ts#L35-L56)). Go's
  `WithOrgTx` rejects an empty organization, sets the same transaction-local
  setting, and commits only after the action succeeds
  ([`org_tx.go#L16-L40`](../../apps/api/internal/dbx/org_tx.go#L16-L40)).
  Go startup also rejects any role other than `chaste_app`, a superuser, an
  RLS bypass role, or a role with memberships
  ([`runtime_role.go#L16-L43`](../../apps/api/internal/dbx/runtime_role.go#L16-L43)).
- High-risk stored invariants include the hash-linked `ledger_events`,
  `approvals` payload and status, `action_receipts` intent and input hash,
  agent `session_events`, version-pinned `agent_run_steps`, worker leases and
  fencing tokens, routine occurrences, and outbox dedupe keys. Their table
  declarations are in `packages/db/src/schema/index.ts` at the corresponding
  exported declarations; the generated manifest gives every table's exact
  declaration line.

## Authentication, identity, and active organization

- Better Auth uses the existing Drizzle tables through its PostgreSQL adapter
  ([`auth.ts#L8-L11`](../../apps/web/src/server/auth.ts#L8-L11)). The stored
  tables are `auth_user`, `auth_session`, `auth_account`, and
  `auth_verification`; account passwords and session tokens remain in the same
  database rows ([`schema/index.ts#L2617-L2668`](../../packages/db/src/schema/index.ts#L2617-L2668)).
- Email and password sign-in requires verified email, sessions last seven
  days, credential endpoints have explicit rate limits, and sign-up avoids
  account-enumeration responses ([`auth.ts#L12-L47`](../../apps/web/src/server/auth.ts#L12-L47)).
  A Go auth cutover must prove an existing password account can sign in and an
  existing session cookie remains valid. Do not rehash passwords, delete
  sessions, or require a password reset as a migration shortcut.
- Session resolution looks up the authenticated email, denies memberships and
  permissions to unverified email identities, validates the active-org cookie
  against the user's current memberships, then resolves permissions in that
  organization ([`session.ts#L26-L68`](../../apps/web/src/server/session.ts#L26-L68),
  [`kernel.ts#L489-L585`](../../apps/web/src/server/kernel.ts#L489-L585)).
  Preserve multi-organization switching and the current permission result.
- The organization GET and POST now enforce that verified-email boundary
  before querying memberships. An unverified session receives an empty org list
  and cannot set the active-org cookie; route regression tests cover both
  methods ([`route.ts#L10-L22`](../../apps/web/src/app/api/org/route.ts#L10-L22),
  [`route.ts#L27-L35`](../../apps/web/src/app/api/org/route.ts#L27-L35),
  [`org-route.test.ts#L1-L175`](../../apps/web/src/server/org-route.test.ts#L1-L175)).
- The signed Go bridge now supports policy reads, ledger reads, and an opt-in
  organization membership switch. The switch assertion binds the verified
  user and requested org; Go rechecks membership in an org-scoped transaction
  under the runtime role before returning the existing active-org cookie. The
  public route stays legacy-owned unless `GO_ORG_SWITCH=1`; the auth catch-all
  remains Next-owned, and Go does not yet validate browser sessions or own
  sign-in, verification, recovery, or session refresh
  ([`route.ts#L29-L109`](../../apps/web/src/app/api/org/route.ts#L29-L109),
  [`go-bridge.ts#L52-L73`](../../apps/web/src/server/go-bridge.ts#L52-L73),
  [`org_switch.go#L32-L85`](../../apps/api/internal/httpapi/org_switch.go#L32-L85),
  [`membership.go#L22-L32`](../../apps/api/internal/orgswitch/membership.go#L22-L32),
  [`route-ownership-overrides.json`](route-ownership-overrides.json)). Policy
  reads remain explicitly opt-in through their own flags
  ([`route.ts#L26-L75`](../../apps/web/src/app/api/policy/route.ts#L26-L75),
  [`route.ts#L101-L130`](../../apps/web/src/app/api/policy/route.ts#L101-L130)).

## Capabilities, approvals, transactions, and audit

- The live capability manifest records 311 registrations across 21 modules.
  Humans, agents, and the existing demos call the same TypeScript executor;
  the target Go executor must preserve the capability ids and schemas
  ([`executor.ts#L104-L138`](../../packages/kernel/src/executor.ts#L104-L138)).
- The executor checks module availability, validates input, evaluates policy,
  verifies an approval against the exact capability and payload, then checks
  the receipt key before an effect. Output validation, execution audit, and
  receipt behavior are part of the same public contract
  ([`executor.ts#L120-L180`](../../packages/kernel/src/executor.ts#L120-L180),
  [`executor.ts#L181-L265`](../../packages/kernel/src/executor.ts#L181-L265)).
- Approval decisions are organization-scoped. Approval or rejection claims a
  pending row with a conditional status update before execution, so a
  concurrent approver cannot execute the action twice. The action's own
  permission is checked before claiming; the executor then verifies the stored
  approval payload ([`approvals.ts#L27-L122`](../../apps/web/src/server/approvals.ts#L27-L122)).
- `executeAtomically` places the capability effect, ledger append, and action
  receipt in one tenant transaction and rethrows audit failure so the effect
  rolls back ([`unit-of-work.ts#L5-L28`](../../apps/web/src/server/unit-of-work.ts#L5-L28)).
  Preserve this transactional path and keep `intentId` idempotency. A repeated
  intent with the same capability and input returns its prior result; a
  different capability or input is a conflict.
- Ledger hashes use SHA-256 over the prior hash and a byte-stable field
  concatenation that includes JSON serialization of the payload and event time
  ([`ledger.ts#L26-L40`](../../packages/kernel/src/ledger.ts#L26-L40)). The
  PostgreSQL writer obtains the existing advisory transaction lock, reads the
  chain head, and inserts the next hash-linked row
  ([`kernel.ts#L150-L180`](../../apps/web/src/server/kernel.ts#L150-L180)).
  Go must continue the existing chain without rewriting historical rows.
- Secret-class capability inputs are redacted before they reach the ledger
  ([`executor.ts#L291-L301`](../../packages/kernel/src/executor.ts#L291-L301)).
  Preserve redaction and the existing separation between secret references
  and values provided to models.

## Agent histories and durable runs

- `agent_sessions` stores the organization, user, mode, status, model reference,
  and token usage. `session_events` stores each ordered user, model, tool,
  approval, and compaction event ([`schema/index.ts#L193-L227`](../../packages/db/src/schema/index.ts#L193-L227)).
- `agent_runs` and `agent_run_steps` record the registry version, contract
  revision, current step, version-pinned capability, input hash, output,
  receipt, approval, and execution timestamps
  ([`schema/index.ts#L287-L312`](../../packages/db/src/schema/index.ts#L287-L312),
  [`schema/index.ts#L3176-L3202`](../../packages/db/src/schema/index.ts#L3176-L3202)).
  Keep prior histories replayable and resume from their stored checkpoints;
  do not reconstruct a trajectory from only the latest visible message.
- Existing tests for durable coordination, run recovery, receipts, approval,
  and worker crash recovery include `apps/web/src/server/durable-coordinator.test.ts`,
  `durable-runs.test.ts`, `effect-receipts.test.ts`, `approvals.test.ts`,
  `harness-approval.test.ts`, `worker-kill.test.ts`, and
  `packages/kernel/src/executor.receipts.test.ts`.

## Existing executable proofs

The public demo commands and current TypeScript entrypoints are:

| Command | Entry point | Existing focus |
|---|---|---|
| `demo` | `scripts/demo-agent.ts` | Real provider-backed agent run |
| `demo:slice` | `scripts/demo-slice.ts` | Customer, invoice, gated payment, approval, balanced trial balance |
| `demo:m2` | `scripts/demo-m2.ts` | Receivables aging and closed-period guards |
| `demo:m3` | `scripts/demo-m3.ts` | Document ingestion and deterministic parsing |
| `demo:m4` | `scripts/demo-m4.ts` | Vendor bill, AP posting, gated payment, financial statements |
| `demo:m4b` | `scripts/demo-m4b.ts` | Hire, leave approval, and payroll draft |
| `demo:m5` | `scripts/demo-m5.ts` | POS session, sale, and drawer variance |
| `demo:m6` | `scripts/demo-m6.ts` | Teams and RBAC, inventory and POS stock integrity, three-way matching, and Creator Mode |
| `demo:support` | `scripts/demo-support.ts` | Provider-backed support-agent proof |
| `demo:m7` through `demo:m13` | `scripts/demo-m7.ts` through `scripts/demo-m13.ts` | Inventory, signals, quote-to-cash, accounting depth, people/projects/expenses, analytics/support/documents, and POS/marketing |

Command declarations are in [`package.json#L17-L28`](../../package.json#L17-L28)
and [`package.json#L42-L46`](../../package.json#L42-L46). The user-facing list
notes that every demo needs a migrated database and some require a real model
provider key ([`README.md#L124-L142`](../../README.md#L124-L142)). CI can skip
provider-backed demos when no key is configured, so a skipped proof is not
evidence of Go parity.

The current demo scripts import the TypeScript registry and executor directly.
Keep the command names and assertions, but replace their runtime adapter so
each proof exercises Go before marking it migrated. `demo:slice` is the first
Phase 2 acceptance proof, not a proof of the current Go service.

## Server action replacement

The generated server-action census contains one action,
`switchOrgAction` ([`server-actions.json`](server-actions.json)). It resolves
the signed-in user, checks membership in the requested organization, sets the
HttpOnly active-org cookie for 90 days, and redirects home
(`apps/web/src/app/(app)/_shell/actions.ts:9-31`).
The `/api/org` POST performs the same membership check and cookie write, then
returns `{ok:true}`. Legacy remains the default; with `GO_ORG_SWITCH=1`, the
Next route signs a short-lived assertion, and Go repeats the membership check
under RLS before writing the matching cookie. The Go path fails closed if its
response or cookie does not match the expected contract
([`route.ts#L26-L144`](../../apps/web/src/app/api/org/route.ts#L26-L144),
[`org-route.test.ts#L1-L321`](../../apps/web/src/server/org-route.test.ts#L1-L321),
[`org_switch_test.go`](../../apps/api/internal/httpapi/org_switch_test.go),
[`org_switch_integration_test.go`](../../apps/api/internal/httpapi/org_switch_integration_test.go)).
The Vite org switcher now uses a Zod-validated client for that API and returns
to `/` after a successful response. Preserve membership denial and cookie
flags; the client never reads or writes the active-org cookie
([`ActiveOrganization.tsx#L1-L112`](../../apps/web-vite/src/components/ActiveOrganization.tsx#L1-L112),
[`organizations.ts#L1-L71`](../../apps/web-vite/src/api/organizations.ts#L1-L71)).
In development, Vite proxies `/api/org` to the legacy server. Keep the browser
hostname `localhost` on both ports so host-scoped session cookies are sent.
The public route and production owner remain legacy while this Go path is
opt-in and parity is verified.

## Required parity evidence before cutover

1. A cloned-database comparison proves table shape and all existing rows remain
   readable by both runtimes. The `data-tables.json` manifest must be current.
2. A password and active-session compatibility test proves existing auth rows
   and browser cookies work through the bridge and final Go auth owner.
3. Cross-organization tests prove active-org membership validation and RLS
   denial for the Go runtime role.
4. Approval race, exact-payload mismatch, retry, and conflicting intent tests
   prove one effect and the existing response semantics.
5. Go appends a valid next audit hash to an existing chain and secret-class
   inputs remain redacted.
6. Existing agent trajectories, unknown-tool behavior, approval pauses, and
   durable run checkpoints replay from existing rows.
7. Every demo command passes against the Go trust spine; provider-backed demos
   must run with their required provider key rather than be skipped.
8. Fixed-machine startup, edit-to-ready, build, API latency, chat start, and
   queue-age benchmarks meet the targets recorded in the migration plan.
