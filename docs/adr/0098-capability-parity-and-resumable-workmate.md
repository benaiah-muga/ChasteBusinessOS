# ADR 0098: Capability parity by default and resumable Workmate sessions

Date: 2026-10-23
Status: Accepted

## Context

A user asked "are there any active projects?". The workmate could only find
`projects.listBoard`, which needs a project id. The human projects page also
loads a project list, but that list was implemented as a special
`projects.list` read operation that bypassed the capability registry and its
audit event. The agent was therefore missing a read the human UI used on every
visit.

An audit of the Go registry found a wider version of the same problem:

- 365 supported capability specs, but only 345 had an entry in the embedded
  discovery catalog. Seventeen executable capabilities, including
  `inventory.listLocationRecords`, `purchasing.listPaymentRunBills`,
  `hr.pendingTimeEntries`, and `support.listLibrary`, could not be found by
  `capability_search` at all.
- The catalog was generated only from the migration manifest plus a
  hand-written tool map. A capability added directly to `capabilitySpecs` was
  executable but invisible unless someone remembered to regenerate the
  catalog or add a tool contract.
- Reads that bypassed the executor did not get the same module gate, policy
  evaluation, ledger receipt, or agent discovery as every other action.
- Workmate kept a session id only in memory. Reloading the page lost the
  thread, and the Agent runs page could replay a session but not continue it.

## Decision

1. **The Go registry is the source of discovery.** After all domain `init`
   functions have registered their specs, `ensureCapabilityCatalog` merges
   every supported, non-hidden capability into the discovery catalog. A new
   capability is visible to `capability_search` and `capability_invoke` as soon
   as it is registered. No second copy in a generated file is required.

2. **Visibility requires an authored contract.** The automatic merge is a
   safety net, not a release path. `TestEveryVisibleCapabilityHasAnAuthoredContract`
   fails when a supported, visible capability has no contract in its spec, the
   migration manifest, or the hand-written agent tool catalog. The contract
   must carry an intent of at least 40 characters and a closed object schema,
   or a union of closed object schemas. The fallback keeps the capability findable during
   development but cannot ship without review.

3. **Hiding is an explicit, reviewed exception.** A spec can be `humanOnly`
   (requires an authenticated human session) or carry an `agentHidden` reason
   (deliberately outside model discovery while still callable by a human or a
   system actor). `TestEveryCapabilityIsDiscoverableOrReviewedHidden` requires
   every exception to appear in a reviewed map with a reason. The current
   exceptions are the rich 500-row CRM collection read (one customer is served
   by `crm.getCustomerProfile`), creator proposal review, the harness approval
   queue, SCIM and SSO credential/identity operations, support widget credential
   settings, and the internal sales-draft and persona inverse checkpoints.
   Every other capability is visible.

4. **The organization persona is a governed capability.** The admin write to
   `agent_soul` used to bypass the kernel even though it steers every agent
   turn. It is now `iam.setAgentSoul`, with `iam.admin`, an audit event, and an
   `iam.restoreAgentSoul` inverse. The agent sees the persona in its system
   prompt and can update it only with an administrator's authority. The agent
   can also read the approval policy it operates under through
   `iam.getOrgPolicy`, so it can explain why an action needs approval.

5. **Coverage is enforced at the module and HTTP layers.** Every installed
   module must have at least one supported, agent-visible capability.
   `TestDirectHTTPWritesAreReviewedExceptions` lists the only HTTP files that
   still write to PostgreSQL outside the executor, each with a reason; a new
   direct write fails until it is governed or reviewed as infrastructure.

6. **`projects.list` is a real capability.** The human collection read now
   parses `{}`, runs as `projects.list` under `projects.read`, takes the module
   gate, writes one `capability.executed` ledger event, and appears in agent
   search. The special `ReadProjectCollection` method and its duplicate
   authorization path are removed.

7. **Workmate sessions are resumable.** The Workmate reads `?session=<id>`,
   fetches the persisted trajectory, rebuilds the visible transcript (text,
   tool activity, record cards, pending approvals, and clarifications), sets
   the session id, and appends the next message to the same server session.
   The active session id is stored per organization and user, so a reload
   restores the last thread. Agent runs gains a "Continue in Workmate" link,
   and the Workmate recent list links directly into continuation. `New`
   clears the stored pointer; the old session remains in Agent runs.

## Consequences

- A page-load list read now writes one ledger event. This is the same audit
  behavior as `projects.listBoard` and the other governed reads, and it makes
  the human and agent paths identical.
- Developers get immediate discovery during development, but CI fails until
  the contract is reviewed. This is the intended ratchet: no silent third
  state between "human can do it" and "agent can find it".
- Some capabilities are still hidden, by reason. Adding a new identity or
  secret capability should default to visible with approval; hiding it requires
  a reviewed reason in the test map.
- The persona write is audited and reversible. It still cannot override
  security, approval, or financial integrity rules, and it requires
  `iam.admin`.
- Direct HTTP writes are a reviewed inventory, not a prohibition. The listed
  files are infrastructure, identity lifecycle, public intake, or ephemeral
  workspace seams; none changes a business module's domain records.
- Resuming a large session is bounded by the existing session detail limits
  (10,000 events, 256 KiB per event, 8 MiB total). A session over that limit
  shows an honest error and can still be replayed in Agent runs.
- The resumed transcript is a reconstruction. Tool arguments and raw results
  are not rendered in the chat, but the server reloads bounded tool history for
  the next model turn, so follow-up work keeps its ids and observations.

## Alternatives considered

- **Keep the generated catalog and add a regeneration step to every capability
  change.** Rejected: the projects gap happened despite a catalog generator,
  because the human read was never a capability and the generator only knew the
  old manifest. The registry itself must be the source.
- **Expose every catalog entry without a contract.** Rejected: an empty schema
  is discoverable but not callable, and a permissive schema invites invalid
  calls that the parser then rejects.
- **Mark identity and secret capabilities human-only.** Rejected for business
  identity operations: they should go through the same governance and approval
  path. The hidden set is limited to operations whose credential material or
  external assertion cannot safely enter a model transcript.
- **Persist the chat transcript only in the browser.** Rejected: the session
  of record is the server trajectory, and resuming must append to it so the
  server can reconstruct tool history.

## References

- [Capability kernel](../../ARCHITECTURE.md)
- [Capability manifest](../migration/capabilities.json)
- [Agent tool contracts](../../apps/api/internal/capability/agent_tool_contracts.json)
- [Module coverage audit](../CAPABILITY_COVERAGE.md)
- [ADR 0092: Workmate capability discovery](0092-workmate-capability-discovery-and-composed-briefs.md)
- [ADR 0097: Agent sources, notification preferences, and turn reverts](0097-agent-sources-preferences-and-turn-reverts.md)
