# ADR 0095: Per-action session checkpoints and declared inverse plans

Date: 2026-10-22
Status: Accepted

## Context

A governed write should be reversible from the session that produced it, but a
generic "revert this turn" is unsafe. The kernel declares inverses for many
capabilities, yet the inverse input often comes from the action output, not the
original input. Some state changes deliberately have no inverse, and a turn can
contain several independent actions that must be reversed in the opposite
order.

Showing a revert button for every action and hoping the executor sorts it out
would damage the trust model. The safe unit is one action with a declared
inverse and an unambiguous identity mapping.

## Decision

1. **Plan inverses explicitly.** `capability.PlanInverse` maps a capability
   output to an inverse input only when the mapping is declared or known to be
   unambiguous. It covers customer creation, project creation, sales orders,
   invoice payments, supplier bill payments, and supplier bills. Capabilities
   without a safe mapping return false.

2. **Revert one action at a time.** `POST /api/sessions/{id}/revert` takes a
   call id, verifies that the session belongs to the signed user, loads the
   stored tool result, builds the inverse plan, and executes it as a human
   action through the capability kernel. The inverse is audited and can itself
   stop for approval.

3. **Show the button only for declared reversals.** The session replay renders
   "Revert action" only for the supported capability set and only after a
   successful result. The first click asks for confirmation; the second runs
   the inverse. A successful reversal refreshes the replay and names the
   inverse capability.

4. **Do not pretend to have snapshots.** This is an action checkpoint, not a
   database snapshot. It does not roll back unrelated changes, and it does not
   offer a whole-turn revert. Irreversible actions have no button.

## Consequences

- A person can correct a mistaken customer, project, order, invoice payment,
  supplier payment, or supplier bill from the exact session that made it.
- Reversal is one action at a time. Multiple actions in a turn must be undone
  individually and in the right order.
- The endpoint executes with human authority and the signed user's permissions.
  If the inverse needs approval, the response says so and the approval queue
  owns the next step.
- The supported mapping list must grow deliberately. A new capability needs a
  reviewed inverse mapping and a test before it appears in the UI.
- The stored tool result is the source of identity. A truncated or missing
  result means no revert button, which is the safe failure mode.
- Whole-turn checkpoints, record snapshots, and undo after later dependent work
  remain future work.

## Alternatives considered

- **Offer revert for every successful tool result.** Rejected: many actions
  have no inverse, and a failed reversal is worse than an honest absence.
- **Store a full row snapshot per turn.** Rejected for this pass: snapshots
  need retention, privacy, and conflict rules. The governed inverse is the
  existing product contract.
- **Let the model invent the inverse input.** Rejected: it would guess ids and
  reasons. The server plans from the stored result.

## References

- [Inverse plan](../../apps/api/internal/capability/inverse_plan.go)
- [Session revert handler](../../apps/api/internal/httpapi/session_revert.go)
- [Sessions page](../../apps/web-vite/src/components/SessionsPage.tsx)
- [Capability kernel](../../ARCHITECTURE.md)
