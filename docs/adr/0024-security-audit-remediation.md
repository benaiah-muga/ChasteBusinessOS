# ADR 0024: Security audit remediation — tenant, supply-chain, and agent boundaries

Date: 2026-08-24
Status: Accepted

## Context

A full adversarial security review of the platform (auth, kernel, API surface,
modules, AI harness, jobs, CI) found issues that share one root cause:
boundaries that were enforced in one code path but trusted elsewhere.

## Decisions

### 1. Agent sessions belong to their creator

`/api/chat` accepted any `sessionId`. Trajectory events and token usage are
per-tenant audit records; appending to a foreign session is cross-tenant
tampering even when capability execution itself stayed scoped. Session reuse
now requires `org_id` + `user_id` match. Replay (`/api/sessions/[id]`) is
owner-only because tool results can carry data the viewer's role would never
authorize directly; org admins keep audit access.

### 2. Marketplace slugs are owned by their first publisher

`publishListing` upserted on slug conflict regardless of who published the
existing row: any org could overwrite a trusted listing with attacker-signed
content and have it stored `verified` (the signature check re-runs against the
attacker's key, so it passed). Slugs are now owned by the original publishing
org; re-versioning requires the same owner. Both publish and install/uninstall
serialize on advisory locks, eliminating the check-then-insert and jsonb
lost-update races. The RLS submitter policy stays as defense-in-depth.

### 3. Queue rows confer one capability's power, never all of them

The worker ran jobs as a system actor holding `*`. Any future bug that lets
an attacker insert a job row would become org-admin execution through the
governed path — the worst possible failure mode for a "single governed path"
design. The actor now holds exactly the target capability's permission;
unknown types fail permanently instead of retrying.

### 4. Expensive and brute-forceable endpoints get explicit budgets

Agent chat fans out into multi-step paid model calls; invitation tokens and
SCIM bearers invite grinding. A dependency-free fixed-window limiter guards
these at the app boundary. It is per-instance (a floor, not a ceiling) and
deliberately simple; a distributed limiter waits until multi-replica
deployment makes that real. Better-auth credential routes get explicit rules
and `trustedOrigins`.

### 5. Conversations are membership-scoped

Org membership alone let any colleague read and post into DMs, at both the
route layer and the `messaging.*` capabilities the agent uses. Membership is
now checked everywhere; agents inherit their principal user's memberships.

### 6. Approvals expire

Pending gates lived forever despite the schema documenting an `expired`
state. Business context moves on; a gate raised last quarter must not be
approvable today. Gates stamp a 7-day expiry at submit, kernel-side verify()
refuses expired rows, and the decision pipeline expires stale pending gates
conditionally (first writer wins).

### 7. Untrusted content is framed as data at the harness layer

Documents, OCR output, memories, and chat transcripts reach the model with
attacker-influenceable text; default org policy allows autonomous writes.
The loop appends a standing rule framing all retrieved content as data, never
commands. This mitigates, it does not eliminate: capability-level gates,
risk classes, and approval flows remain the enforcement boundary. Model-filed
tickets are length-bounded before storage or notification.

### 8. Membership changes stay human

`iam.inviteMember` was risk `write`, so an agent could autonomously extend
org membership from injected instructions. Invitations are now refused for
agent actors outright (humans keep the one-step flow). SCIM provisioning
remains IdP-driven by design.

## Known debt

**RLS is inert for the application role.** Migration 0014 installs
tenant-isolation policies, but `DATABASE_URL` connects as the table owner,
and Postgres owners bypass RLS without `FORCE ROW LEVEL SECURITY`. Today the
app relies on application-level org filters alone; ADR 0017's probe role
proves the policies work when they apply. Remediation (non-owner app role +
`FORCE` + `withOrgContext` everywhere) is an ops-coordinated migration, not a
code-only change; tracked here so it is not forgotten.

## Consequences

- Cross-tenant trajectory injection, listing takeover, wildcard worker
  execution, unbounded agent spend, DM exposure across members, agent-initiated
  membership changes, and immortal approvals are all closed.
- Republishing a marketplace package under a new version now requires the
  original publisher — intentional friction against takeover.
- Rate limits are conservative defaults; tune via env before scale-out.
