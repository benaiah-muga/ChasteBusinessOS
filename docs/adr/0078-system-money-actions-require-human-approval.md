# ADR 0078: System money actions require human approval

Status: accepted

## Context

The Go capability worker executes as a system actor. Money capabilities may
depend on ledger state, so their final amount can be unknown before execution.
Allowing a system actor to execute these capabilities without a verified
approval would bypass the approval boundary preserved for human and agent
actions.

## Decision

- System-actor money capabilities use the same autonomy threshold as agent
  money actions. Amounts above the threshold and amounts that cannot be known
  before execution require human approval.
- A worker may execute the capability only when its job carries the approval
  ID in `executing` state, scoped to the same organization and capability,
  unexpired, and bound to the same canonical input.
- A worker job that requires approval but lacks that approved ID fails closed
  and does not create a new pending approval or perform the business effect.

## Consequences

Queue producers must attach the approval ID after a human decision for gated
actions. Pending, expired, cross-organization, wrong-capability, or
payload-substituted approvals cannot authorize system money execution. Money
actions within the configured threshold retain autonomous execution.
