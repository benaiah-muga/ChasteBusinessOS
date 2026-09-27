# ADR 0073: Preserve the governed capability path in Go

Date: 2026-09-27
Status: accepted for the migration implementation; public ownership remains gated by parity

## Context

The existing TypeScript kernel is the common path for human and agent actions.
It validates capability inputs, checks module availability and permissions,
evaluates organization policy, requests or verifies approval, checks intent
receipts, executes the capability, validates output, and appends a hash-chained
audit event. Transaction-backed calls keep the effect, audit, and receipt in one
organization-scoped transaction.

The first Go write capability is `crm.createCustomer`, the first business step
in the existing `demo:slice`. A direct SQL handler would bypass governance and
create a second action path. The BFF currently owns Better Auth session
resolution and verified-email handling; agent contexts can also narrow a
human's permissions, so Go cannot replace an agent's effective permissions
with the user's wider role grants.

## Decision

- Implement a Go capability registry and executor. Capability definitions own
  the id, input and output contracts, module, risk, permission, inverse, and
  effect. Human routes and agent tools call this executor, not module SQL
  directly.
- Execute permission, module, policy, approval, receipt, effect, audit, and
  receipt persistence inside one `dbx.WithOrgTx` transaction. Keep the
  TypeScript executor's ordering: module check, input validation, current
  authority and policy, approval, intent receipt, effect, output validation,
  audit. Approval decisions claim a pending row conditionally before invoking
  the same executor with the exact approved payload.
- Continue the existing global ledger chain. The Go writer uses the same
  advisory transaction lock, event fields, millisecond event time, JSON payload
  serialization, SHA-256 concatenation, and genesis value. Any effect, audit,
  or receipt persistence error rolls the transaction back. The additive
  `chaste_ledger_chain_head()` function exposes only the global tail hash to
  the least-privilege runtime role so appends continue the existing cross-org
  chain under tenant RLS.
- Use a short-lived `go.capability.execute` HMAC assertion from the BFF. It
  binds the capability id and canonical input digest as well as the domain user
  id, organization, actor type, effective permissions, Better Auth session id,
  optional agent-session id, and optional intent id. Do not forward browser
  cookies or session tokens. The Go service verifies the assertion, then checks
  the active Better Auth session, verified email, normalized auth-email to
  domain-user binding, current organization membership, and current database
  permissions inside the scoped transaction. Effective permissions from the
  assertion are intersected with current database grants, preserving narrower
  agent authority without permitting the BFF to grant more than the user has.
- The BFF signer requires the actor id to equal the authenticated domain user
  id and requires an agent-session id for agent actors. Its executor adapter
  validates the private Go URL and response shape, never forwards browser
  cookies, refuses redirects, and distinguishes a request that was not sent
  from a dispatched request whose outcome is unknown. Callers must not retry an
  unknown write without reconciling its intent receipt.
- Keep `/api/customers` legacy-owned by default. The internal Go executor now
  implements `crm.createCustomer`, `crm.deactivateCustomer`,
  `crm.updateCustomerProfiles`, `crm.restoreCustomerProfiles`, and
  `crm.reapplyCustomerProfiles`. The Go port keeps the existing merge restore
  snapshot contract, including its caller-supplied snapshot risk, as recorded
  in ADR 0074. Do not route writes to Go until the matching approval-decision
  and agent-tool paths can complete through the same Go executor and the
  trust-spine gates pass. Never dual-run a write.
- Preserve existing receipt semantics for gated requests: an approval request
  is not a completed effect and is not served from an effect receipt. Any
  improvement to retry identity across an approval pause must update both
  runtimes and their fixtures before the route owner changes.

## Consequences

Go write capabilities become testable without moving the public route first.
The BFF remains the browser identity adapter during this phase, while Go
rechecks revocation and authorization against PostgreSQL. PostgreSQL schema,
Better Auth rows, customer data, existing receipts, and ledger history remain
the shared source of truth. Public ownership changes only after Go approval
execution, human and agent dispatch, cross-language ledger vectors, and the
relevant demo proofs pass.

The current TypeScript customer route does not use the transaction-backed unit
of work, and concurrent requests with the same intent can race there. Go must
serialize same-intent executions within its transaction. A deployment must
still have one active writer for the create action during cutover; the route
must not be split between TypeScript and Go instances while parity is pending.

## Cutover blockers

- The TypeScript customer route does not use the transaction-backed unit of
  work. Its audit append can fail after the customer effect commits, producing
  an unknown outcome; the Go path rolls back effect, audit, and receipt
  together. The Go invariant is retained for now, but the old and new failure
  fixture must be compared and this difference resolved before a write route
  moves. Do not describe the current slice as full failure-path parity.
- Jobs and routines use `system` actors. The current BFF capability assertion
  intentionally rejects them and Go requires a real authenticated user. A
  worker-scoped signed assertion must preserve system actor attribution and
  capability-scoped permissions before worker capabilities can use this
  executor.
- `crm.createCustomer`, `crm.deactivateCustomer`, and customer profile update
  with its restore/reapply inverses are the Go write capabilities currently
  implemented. Public customer route ownership also depends on merge/restore,
  approval decisions, and agent-tool dispatch using the same Go path.
- The Go policy port must match the actual TypeScript `OrgPolicyEngine`
  decisions. For the current CRM `write` risk class, a matching
  `requires_approval_for: ['write']` rule does not require approval for a
  permitted human. Keep that result in the migration parity fixtures; changing
  it requires a separate policy change applied to both runtimes.
- The legacy approval path commits a rejection before its ledger event and
  commits an approved action before finalizing the approval row. The internal
  Go decision service currently has the same boundaries. Add failure-injection
  fixtures and decide on atomicity or recovery before the approval route moves.
