# Enterprise engine delivery plan

Branch: `engine/durable-replay-pilot`

The programme is delivered in dependency order. Each leaf must leave an
executable gate and a user-visible or operator-visible proof.

| Leaf | Deliverable | Owns | Depends on | Gate |
|---|---|---|---|---|
| D1 | Durable agent run contract: run, step, checkpoint, pause/resume, cancellation, and receipt linkage | `packages/db/**`, `packages/kernel/**`, `apps/web/src/server/**`, migrations, tests | existing jobs, approvals, action receipts | `DR-*` |
| R1 | Canonical replay: version-pinned observations and deterministic replay with no live model or duplicate effect | `packages/kernel/**`, `apps/web/src/server/**`, replay tests | D1 | `RP-*` |
| P1 | Supervised purchasing pilot: shortage → PO → receive → bill → pay → correction, human/agent parity and browser proof | `scripts/**`, `apps/web/src/**`, `modules/**`, gate docs | D1/R1 | `PILOT-*` |
| G1 | Capability catalogue and durable feature-gap ticket with honest agent fallback | `packages/kernel/**`, `modules/creator/**`, `apps/web/src/**`, `packages/db/**` | R1 | `GAP-*` |
| C1 | Isolated Creator pipeline: sanitized fixture, isolated worktree, independent verifier, artifact digest, promotion and rollback handoff | `modules/creator/**`, `scripts/**`, worker tooling, tests | G1 and R1 | `CREATOR-*` |

## Sequence status: delivered

D1, R1, P1, G1, and C1 now have passing executable gates in
`GATES-ENGINE.md`. The first durable purchasing run proves that a run can
resume after a worker crash, preserve its version-pinned step contract, and
commit exactly one governed effect. Replay is read-only and receipt-backed;
the supervised pilot proves human/agent postcondition parity; capability gaps
become durable tickets; and Creator candidates remain isolated, independently
verified, digest-pinned, and unpromoted.

The next architectural step is the general Cordis composition runtime and its
consolidation adapter. It should consume these durable contracts rather than
introducing a second execution or replay model.

## Current leaf: W6 — controlled evolution release

The first composition slice is intentionally narrow: add a pure `@chaste/harness`
runtime for versioned profiles, deterministic bundle/patch composition, typed
service lifecycle, and live runtime events. The web adapter mounts the existing
registry and `KernelExecutor` as the only capability authority. It must not add
direct module calls, production code execution, or a second replay path.

Acceptance for the composition boundary and persisted identity is tracked in
`GATES-HARNESS.md` and `GATES-INSPECTION.md`, and is delivered. The current
slice adds a profile-aware coordinator tracked in `GATES-COORDINATOR.md`: it
resolves the tenant-owned snapshot, verifies the live adapter can represent
that exact composition, mounts the existing kernel bridge, and creates the
durable run only after identity checks pass. H4 adds an explicit approved
bundle resolver list tracked in `GATES-BUNDLES.md`: registered bundles can
mount alongside the ERP bridge, persisted patches reach runtime config, and
unknown manifests still fail closed. H5 now governs composition approval in
`GATES-APPROVAL.md`: the existing kernel approval inbox and decision path
authorize an exact immutable digest, and the coordinator refuses to mount or
create a run without an executed matching approval. W6 now adds a durable,
approval-gated Creator release handoff tracked in `GATES-EVOLUTION.md`: only
an approved proposal's exact isolated-candidate digest can be staged or
promoted, and staged/promoted handoffs can be rolled back conditionally. The
handoff records artifact metadata only; it does not install or execute source
in production. The canary outcome slice now binds that handoff to its original
`capability_gap` ticket and records pass/fail evidence through the separate
`platform.creator.release` permission; outcomes do not implicitly deploy or
roll back the promoted artifact. Deployment-principal provisioning,
automatic rollback, and executable tenant plugins remain later gaps.

The current UI integration keeps those contracts in the existing product
surfaces: `/sessions` carries durable run dossiers and true replay, `/proposals`
carries capability gaps and Creator release/canary state, `/approvals` remains
the decision inbox, and Settings carries safe harness composition inspection.
No separate operations app was introduced. The next leaf is the separate
deployment-principal/CI canary adapter.
