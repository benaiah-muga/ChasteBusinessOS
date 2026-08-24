# SOC2-Style Control Mapping, ChasteBusinessOS

Date: 2026-08-23
Status: Living document; maps platform controls to common SOC 2 Trust Services
Criteria. Not a certification or an auditor's opinion, a control inventory an
auditor (or customer) can walk.

## CC1, Control environment

| Criterion | Platform control | Where |
|---|---|---|
| Governance of agent authority | Agents and humans act through the same capability pipeline; agents hold no powers humans don't govern | `packages/kernel`, ARCHITECTURE §2 |
| Integrity by default | Append-only, hash-chained event ledger; tampering detectable | `ledger_events` table, ADR 0002 |
| Honesty over improvisation | Unknown capability ⇒ ticket filed, never hallucinated action | `runAgentLoop` + ticket sink |

## CC6, Logical access

| Criterion | Platform control | Where |
|---|---|---|
| Tenant isolation | RLS policies on all tenant tables keyed to `app.org_id`; probe-tested under a NOBYPASSRLS role | migration `0014_rls_everywhere.sql` (and every later tenant-table migration, e.g. `0020` manufacturing tables), ADR 0017, `packages/db/src/rls.test.ts` |
| Least privilege | Per-capability permission keys; RBAC roles scoped per org | `packages/kernel/policy.ts`, IAM module |
| Identity changes gated | Identity-class actions always human-approved | kernel hard gates |
| Federated identity | SSO connections per org (SAML/OIDC metadata, domain routing) | `sso_connections`, `/api/team/sso` |
| Automated provisioning/deprovisioning | SCIM 2.0 Users endpoint with hashed bearer tokens; membership-only grants, role assignment stays governed | `/api/scim/v2/Users`, `scim_tokens` |
| Secret handling | SCIM tokens stored SHA-256 only; secrets never rendered to models | `secret` risk class |

## CC7, System operations

| Criterion | Platform control | Where |
|---|---|---|
| Change management for agent-authored change | Creator proposals = diff + test evidence + risk doc; human merge, CI-gated | ADR 0012, creator module |
| Supply-chain integrity of extensions | Signed plugin manifests (canonical JSON + ed25519), re-verified at install | ADR 0018, `@chaste/plugin-kit` |
| Destructive operations | Period/year close are approval-gated with declared inverses | accounting module |
| Auditability | Every consequential event in the hash chain with actor type/id | ledger viewer UI |

## CC8, Change management

| Criterion | Platform control | Where |
|---|---|---|
| Reversibility | Every state-changing capability declares an inverse; boot-time conformance enforces presence/validity | `assertWellFormedCapability` |
| Immutable financial corrections | Posted documents never mutate; corrections are mirror reversals | ADR 0004 |
| Year-end integrity | Closing entry balanced by construction; December sealed in same transaction | ADR 0019 |

## A1, Availability / resilience (partial)

| Criterion | Platform control | Where |
|---|---|---|
| Bounded resources | Capped DB pool; compaction bounds agent context growth | `client.ts`, `kernel/compaction.ts` |
| Notification fan-out fails soft | Webhook/email failures log but never block approvals | `apps/web/src/server/kernel.ts` |

## Known gaps (honest list)

- SSO assertion exchange is groundwork: connection storage + domain routing
  exist; the better-auth SSO handshake is not yet enabled end-to-end.
- Pen-test pass and formal evidence collection have not been performed.
- Marketplace listings lack publisher reputation/moderation workflow.
