# ADR 0055: Actor-aware authority

Date: 2026-09-20
Status: Accepted

## Context

The kernel's policy engine treated every actor identically for high-stakes
risk classes: `identity` and `destructive` capabilities always required
approval, and org money thresholds gated humans and agents alike. The result
in practice: a permitted human clicking "disable marketing" in the module
switchboard had to walk to the Approvals inbox and approve their own click.
That is not dual control, it is a self-signature, and it trained users to
rubber-stamp gates. Worse, the module switchboard defect chain (catalog
omitting iam, full-set saves) could permanently disable the iam module,
whose own re-enabling capability was then refused by the executor's module
gate: an org-bricking deadlock reached through ordinary UI use.

## Decision

1. **A permitted human acts under their own authority.** For
   `identity`/`destructive` capabilities, an actor of type `human` holding
   the capability's permission executes directly; the event ledger entry is
   the control. `DefaultPolicyEngine` no longer forces approval for humans.

2. **Non-human actors keep every gate.** Agents and system jobs remain
   approval-gated for `identity`/`destructive` always, and for `money` above
   the capability's threshold (null amounts still fail closed). Approval
   gates exist for actors nobody can trust implicitly; they are not a ritual
   for humans.

3. **Maker-checker is an org choice, not a default.** The policies table's
   previously unused `requiresApprovalFor` jsonb now holds risk-class
   strings (or `"*"`) that re-impose dual control for humans per capability
   pattern. Empty (the onboarding default) means humans act freely. Human
   money gating follows the same flag: with `money` in the set, the org's
   threshold applies to humans too.

4. **The org's autonomy cap (`maxRiskAutonomous`) governs agents and system
   jobs only.** Human authority is bounded by RBAC permissions, not by
   autonomy caps meant to bound the workmate.

5. **Attribution is first-class.** `requestedByUserId` on approvals records
   the acting user for both actors (an agent's `actor.id` is the principal
   it works for); `ledger_events` gains a `session_id` column identifying
   the agent session behind an event. The session id is deliberately NOT
   part of the hash chain input, so pre-existing entries stay verifiable.

6. **Protected spine modules.** `iam`, `signals`, and `routines` can never
   be disabled: the capability write paths union them into every saved set
   (`iam.setModules`/`iam.restoreModules`), the kernel module gate always
   reports them enabled, and the switchboard renders them locked-on.

## Consequences

- Humans no longer approve their own clicks; the Approvals inbox becomes
  what it was meant to be: the queue of agent-proposed actions.
- Strict enterprises (or auditors requiring dual control) can turn on
  maker-checker per risk class through org policy; a Settings surface for
  that flag arrives with the governance settings work.
- Demos that asserted human gating (period close, POS returns) now prove
  the gate with agent actors, matching production semantics.
- Disabling a module can no longer strand the org: the spine always
  answers, and the historical "module iam is disabled" deadlock is
  unreachable by construction.

## Verification

- `packages/kernel/src/policy.test.ts`: the full actor x risk x strict matrix.
- `apps/web/src/server/modules.test.ts`: human applies switchboard changes
  directly; agents gate; protected ids survive every save shape; the module
  gate honors protection even against a stale org row; shell catalog and
  iam module agree on the spine list.
