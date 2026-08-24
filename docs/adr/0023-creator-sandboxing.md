# 0023 - Creator Mode sandboxing: proposals execute in isolation before review

Date: 2026-08-24
Status: Accepted (design; implementation deferred, tracked in ROADMAP)

## Context

Creator Mode lets the platform propose changes to itself: a capability diff,
tests, and a risk document (ADR 0012), distributed as signed manifests
(ADR 0018). The open roadmap item is a sandboxed dev container with
branch-per-proposal workflow. Today a proposal is inert text; the gap is
proving it *runs* - not just that it reads well - without giving proposal
code access to production data or credentials.

## Decision

1. **Proposals are executed in an ephemeral environment** (container or
   ephemeral CI runner) seeded with: a scratch Postgres from migrated
   migrations only, synthetic fixture data generated from schemas, and no
   network egress except the model provider allowlist.
2. **Verification gates, in order**: conformance (`assertWellFormedCapability`
   plus registry boot), property tests for any financial invariants touched,
   golden-trajectory evals (see `packages/kernel/src/eval.test.ts`) covering
   every new/changed capability, then human review of the diff + risk doc.
   A proposal that cannot run to green is not reviewable.
3. **The sandbox never sees tenant data.** Fixtures derive from schema shape,
   not row contents; org memory and documents are stubs. This keeps the
   self-development loop useful while making data exfiltration structurally
   impossible rather than policy-prohibited.
4. **Install-time re-verification.** Marketplace installs re-run conformance
   and signature checks on the target system (already implemented); sandboxed
   test results ship inside the signed manifest so reviewers see evidence,
   not claims.

## Why deferred

Requires CI container infrastructure and fixture generation. The governance
surface it protects (proposal -> review -> signed install) already enforces
human authority at every step, so the sandbox raises confidence, not safety.
