# Enterprise evolution: dependable operations, human control, continuous improvement

Status: proposed implementation programme; no enterprise readiness certification.  
Review baseline: `1f3b078`, 2026-09-10, branch `cordis-like-engine`.  
Audience: engineering, architecture, product, UX, security and operations leads.

## 1. Decision and relationship to the existing plan

Extend [CORDIS_LIKE_ENGINE_PLAN.md](CORDIS_LIKE_ENGINE_PLAN.md), retain its capability authority boundary, and change its implementation order. Dependable transactions, explicit delegated authority and recovery must precede a general composition runtime. An ERP earns autonomy by preserving business invariants under failure, not by mounting more tools.

Keep the modular monolith, PostgreSQL, pure domain math, shared capability executor, existing modules and navigation. Introduce abstractions only at demonstrated boundaries. Start with one operational workflow and one independently verified development workflow. A broadly useful product can have a narrow first enterprise release: select a customer segment and jurisdiction before promising comprehensive accounting, payroll or statutory support.

This document owns enterprise readiness and the expanded delivery order. The original plan owns its detailed harness/replay proposal where compatible. [ROADMAP.md](../ROADMAP.md) remains historical delivery tracking; checked milestones are not evidence of production certification. ADRs below are proposals until reviewed; existing accepted ADRs remain intact.

### What changes in the original plan

| Original element | Treatment in this extension |
|---|---|
| Capability kernel remains authority | Retain; audit entry points that currently sit outside it, including bootstrap and setup. |
| Phase 0 upstream inventory | Retain as a bounded investigation; freeze source, license, maintenance and compatibility evidence before borrowing code. No dependency adoption decision is made here. |
| Phase 1 composition before Phase 1.5 reliability | Reverse the critical dependency. Reliability must work against the existing registry before composition generalization. |
| Fixed action key based on run/step/tool call | Extend to client-originated intents, semantic payload binding and external effect reconciliation. |
| Reversible effects | Distinguish exact undo, compensating business action and irreversible external consequences. |
| Canonical replay | Retain three replay modes; add privacy retention, verifier isolation and explicit non-replayable observations. |
| Self-evolution ladder | Retain; separate proposal author, verifier and deployment authority, and close the post-release learning loop. |
| Broad UI integration in last phase | Keep advanced runtime screens late; ship progress, exceptions, control and recovery with the backend features they expose. |
| A → B → C0 first wave | Replace with baseline evidence → integrity/security → durable workflow → constrained autonomy; composition is conditional. |

### Success and deliberate limits

Users should be able to say “keep approved items in stock within this budget,” inspect the mandate, see a purchase proposal or authorized execution, interrupt it, and reconcile the outcome after a restart. An operator should understand an exception without reading model traces. A developer should run a useful local system without buying model access. The system should turn a verified capability gap into a reviewable, tested release candidate and measure whether the release actually solved the gap.

Initial non-goals: universal industry coverage, automatic platform merges, unrestricted customer code, a new workflow language, whole-database event sourcing, a microservice rewrite, and production financial writes while offline. Multi-entity consolidation and localization are demand-gated work with explicit eligibility limits, not silent gaps.

## 2. Evidence register: facts, implications and open investigations

This is a targeted source review, not a penetration test or exhaustive line-by-line audit. “Observed” means visible in the cited implementation. A risk inferred from code needs a reproducer before engineers label it a confirmed vulnerability. Static findings must be refreshed against the implementation commit before fixing.

| ID | Source and observed behavior | Consequence and required work |
|---|---|---|
| F01 | `packages/kernel/src/executor.ts`: capability executes before a separate audit append; catch reports failure and attempts another append. `apps/web/src/server/kernel.ts`: `PgLedgerStore.append` starts its own transaction. | A committed domain write can be reported failed after audit failure. Introduce an atomic local effect/audit boundary and explicit outcome-unknown semantics; test the failure window. |
| F02 | `executor.ts` validates input but does not parse `cap.output`; `capability.ts` permits `ok: true` without data through optional fields. | Output conformance and discriminated results belong at the trust boundary. Invalid output after a committed write must not cause blind retry. |
| F03 | `apps/web/src/server/jobs.ts`: claims set `processing`; no lease/recovery in the inspected claim path. Failures return to `pending` immediately. | Worker death can strand jobs; retries can hammer dependencies. Add leases, fencing, delayed availability and a visible dead-letter process. |
| F04 | `jobs.ts`, `processRecurringBatch`: claim updates `last_run_at`, while eligibility uses unchanged `next_run_at`; invoice creation and schedule advance are separate. | After the claim statement commits, another worker can select the same due template. Crash/retry can also duplicate an invoice. Prove with two workers and enforce occurrence uniqueness transactionally. |
| F05 | `apps/web/src/server/session-events.ts` logs final persistence failure and returns. `packages/kernel/src/loop.ts` runs with an in-memory message list and step limit. | Playback can be incomplete; a transcript is not a recovery checkpoint. Persist required run transitions durably and classify missing evidence honestly. |
| F06 | `packages/kernel/src/policy.ts`: ordinal risk ranking and per-action amount thresholds; `jobs.ts` builds a system actor from the queued capability permission. | System work needs provenance and a persisted delegation ceiling. A permission for one action is not evidence the enqueueing principal was entitled to delegate it. Test system/human/agent paths and cumulative exposure. |
| F07 | `apps/web/src/server/approvals.ts`: conditional claim protects concurrent approval; rejection branch occurs before capability-permission check. `apps/web/src/app/api/approvals/route.ts` POST checks session/org but adds no capability-permission check. | Preserve the claim protection. Source indicates a same-tenant rejection-authority gap; reproduce with a restricted member knowing an approval ID. Enforce explicit decision authority in the shared decision service and prove unauthorized rejection fails. Also resolve crashed `executing` states safely. |
| F08 | `modules/creator/src/index.ts`: `scaffoldCapability` is risk `read`, but default `submitAsProposal` inserts a proposal; stores `renderTestSkeleton` as `testEvidence`. `scaffold.ts` emits a placeholder assertion. | A read classification can conceal a write; generated test text is not executed evidence. Split render/submit, type evidence provenance and block release on placeholder tests. |
| F09 | `packages/db/src/client.ts`: tenant transaction setting exists, explicitly ineffective for bypass roles. Creator has direct `deps.db` access; many other modules use `withOrgContext`. | RLS cannot be assumed universal from architecture prose. Inventory every DB path and deployed role; test with actual non-owner runtime roles. |
| F10 | `apps/web/src/server/kernel.ts`: one constant advisory lock protects a global ledger chain. ADR 0022 already proposes per-org heads. | Real contention candidate, not a measured bottleneck. Instrument wait time, implement tenant chains with explicit historical segment continuity when warranted. |
| F11 | `apps/web/src/server/onboarding.ts`: embedding call inside organization transaction; ledger append after commit; slug availability checked beforehand. Setup updates replace a settings snapshot. | Slow model dependency extends transaction lifetime; failures and concurrent submissions need idempotency; simultaneous setup updates can lose changes. |
| F12 | `apps/web/src/lib/onboarding-flow.ts` and wizard tests arrived from remote; existing fresh/import/connect paths and deferred steps already exist. | Improve their persistence, correctness and first value; do not rebuild a wizard merely to add steps. Current fallback “Nothing was changed” is not justified after an uncertain network/commit outcome. |
| F13 | `apps/web/src/server/rate-limit.ts`: process-local counters and client IP read from forwarded headers. | Limits are not a multi-replica budget. Define trusted proxy behavior, aggregate quotas and model spend reservations. Deployment configuration is unverified. |
| F14 | `packages/db/src/schema/index.ts`: many money totals use PostgreSQL `integer`; some FX values use bigint with JS number mode. | Test signed 32-bit monetary limits and JS safe-integer boundaries. Choose exact range/serialization before claiming enterprise volume or arbitrary currency support. |
| F15 | `.github/workflows/ci.yml`: demo step runs only slice, m4 and m5, conditional on NVIDIA key. README/ROADMAP describe many more demos. | CI green does not cover all milestone proofs. Separate deterministic DB proofs from paid-provider acceptance and publish skipped coverage. |
| F16 | `apps/web/src/server/auth.ts`: inspected configuration enables email/password; ROADMAP describes SSO connection storage/domain routing. | Storage/routing is not proof of a complete SAML login and lifecycle implementation. Trace routes, callbacks and deprovisioning before advertising enterprise SSO. |
| F17 | ADR 0023 and ROADMAP explicitly defer executable creator sandboxing. | Creator is a proposal/scaffolding foundation. A signed manifest or installed-listing record is not evidence of isolated execution, trustworthy publisher identity or verified deployment. |

Additional investigations: authorization on exports/search/attachments; tenant-composite foreign keys; policy revocation during queued work; closed-period concurrency; counterparty changes between approval and payment; outbound webhook SSRF; secret material in trajectory/error bodies; actual backup restore; browser accessibility and interaction performance. These are required test subjects, not asserted exploits.

## 3. Backend architecture and execution contracts

### B01 - One governed command path and an explicit bootstrap exception (P0)

Owner: kernel lead; reviewers: security and domain leads. Depends on baseline inventory.

Map each human route/server action, chat tool, import row, webhook, scheduled action and creator request to a capability or a documented infrastructure operation. Reads need authorization too, including search and exports. Never build model-controlled SQL or expose ORM handles through tools.

Tenant creation cannot require an existing tenant. Define a narrow authenticated bootstrap service that creates the organization, first membership, owner role, initial policy and audit event atomically with a client intent key. It is the only initial authority-grant exception, has rate limits, cannot create another user's membership, and cannot be called by a normal business agent. Subsequent setup changes use ordinary governed capabilities. Add import-boundary lint rules so route handlers cannot grow ad hoc domain writes.

Gate: enumerate all entry points; run the same authorized and forbidden fixture through UI adapter, agent adapter and worker; prove identical decisions/effects. Bootstrap concurrency returns one organization per creation intent; intentional creation of another organization uses a distinct intent and explicit eligibility rules.

### B02 - Atomic local effects, idempotency and stable receipts (P0)

Owner: kernel + database leads. Depends on B01 contract; migrate one payment path first.

Use a tenant-scoped unit of work. In one short database transaction: resolve current authority and preconditions, reserve/validate action identity, execute deterministic domain mutation, validate output, append the local audit fact and effect receipt, and enqueue necessary outbox messages. Inject that transaction into participating module repositories; starting independent module transactions is not equivalent. Audit recording must accept the same transaction rather than acquire another connection/lock. Set a consistent lock order and retry serialization conflicts only around the full idempotent operation. Never hold this transaction across model, email or payment-provider calls.

Action identity: `(org_id, intent_id, operation_id)` unique, with principal/delegation identity, capability schema version and canonical input digest. UI generates an intent before submitting and retains it across retry; agents derive operation IDs from durable planned steps, not a fresh model tool-call ID after restart. Same key + changed payload is a conflict. Re-reading a receipt requires current access authorization; dedupe must not leak an old result to a newly unauthorized user.

Persist `action_intents`/effect receipts with statuses `accepted`, `waiting_approval`, `committed`, `failed_before_effect`, `outcome_unknown`, `compensated`. Keep attempts separate from semantic action identity. Distinguish the governance audit stream, business facts and run observations; they may share infrastructure but need distinct retention and schemas. Do not rewrite every domain table into events.

Gate: inject failure before write, after write, during audit, after commit/before response and after response loss. Every retry yields one business effect and one authoritative receipt, or an explicit reconciliation case; a committed effect is never labelled “nothing changed.” Concurrent 100 identical requests and reused keys with changed inputs are part of the proof, not just sequential duplicate calls.

### B03 - Recoverable queue, external effects and business workflows (P0)

Owner: runtime lead. Depends on B02 identity contract.

Jobs need `available_at`, `lease_owner`, `lease_expires_at`, monotonically increasing fencing token, attempts, deadline, cancellation state, last error code and originating delegation. Claim a bounded batch; heartbeat only while the owner remains current. A reclaimed job prevents the old worker from committing through token checks. External systems that cannot enforce fencing require reconciliation, not an exactly-once promise.

Use at-least-once delivery with idempotent consumers, exponential backoff/jitter, provider retry hints, maximum elapsed retry time and dead-letter ownership. Separate `waiting_approval` from transient failure; do not resubmit approval requests each queue retry. Keep retries for business denials disabled. Add per-tenant fair scheduling and separate concurrency pools for POS/interactive operations, ingestion, routine scans and creator workloads.

Scheduled occurrence uniqueness is `(org_id, schedule_id, scheduled_for)`; insert occurrence and advance schedule atomically. Persist timezone, schedule revision, pause windows, overlap rule and missed-run policy (`skip`, `latest_only`, bounded `catch_up`). Test DST changes, clock jumps, long outages and month-end calendar semantics. Recurring invoice and routine schedules share this occurrence primitive.

External effect contract: write an outbox intent, commit, send with provider idempotency where supported, store acknowledgement and reconcile asynchronously. Bind recipient, destination account, amount/currency and content digest. An external timeout can mean delivery occurred. Poll/query provider receipt or present a reconciliation case; never send again solely because an HTTP response was lost. Compensation may mean a refund or corrective message, not erasing an email or recalling a completed transfer.

Gate: kill worker at every transition; reclaim stale lease; let the stale worker return late; redeliver both job and provider webhook. No duplicate committed internal effect, no silently lost occurrence, no unbounded retries, no unauthorized re-drive. Test a provider with no idempotency support explicitly.

### B04 - Durable plans, interruptions and delegation (P0/P1)

Owner: agent-runtime lead. Depends on B02/B03.

Persist `agent_runs`, `run_steps`, checkpoints, task-contract revision, event sequence, budget reservations and parent/child lineage. Define states including `waiting_user`, `waiting_approval`, `paused`, `cancel_requested`, `cancelled`, `blocked`, `failed`, `completed`; keep cancellation intent separate from terminal result. Resume committed steps from receipts. Pin capability/model/profile versions for playback; if old versions are unavailable, require a visible replan/migration instead of silent execution under changed semantics.

A user correction creates a new contract revision. Stop pending incompatible steps, preserve committed effects, show compensation options and re-authorize the remainder. Two users editing a business object use expected-version conflict detection; two agents cannot “win” by overwriting each other's plan. Delegated child work gets a permission intersection and shared resource reservations, never the parent's entire authority by default. Start with sequential steps and bounded fan-out for independent reads; add write parallelism only with explicit conflict domains.

Acceptance is business state: e.g. “one approved PO exists for these shortages within this budget,” not “assistant said done.” Record unmet requirements, contradictory instructions, evidence freshness and responsible next actor. No run continues indefinitely because a model says it needs more time.

Gate: restart through a multi-module workflow; compact while awaiting approval; revoke actor access; change a price; cancel during an external timeout; amend user intent. Each case has a deterministic terminal or waiting state, an accurate receipt, and no authority escalation.

### B05 - Capability contracts, business events and modules (P1)

Owner: architecture lead. Depends on B01/B02.

Extend capabilities incrementally with version, side-effect category, resource scope, monetary exposure source, idempotency semantics, preconditions, postconditions, output schema, error schema, freshness requirement and compensation type. Use risk facets (money, identity, external communication, sensitive data, irreversible effect) alongside existing risk class; a single ordinal cannot describe a payroll export or bank-detail edit adequately.

Return a discriminated result: success with receipt and data; pending with continuation/approval; conflict with current version; denial with safe reason; failure with code/retry policy; unknown with reconciliation reference. Output validation occurs before local commit. For external effects, validate acknowledgement and preserve uncertainty without pretending rollback occurred.

Events carry tenant, schema version, causation, correlation and aggregate version. Consumers dedupe and track a high-water mark. Publish compatibility/deprecation windows and upcasters for retained schemas; replay does not run current event handlers against old events without compatibility checks. Disabled modules cannot bypass mandatory accounting or stock invariants: refuse the primary action when an essential dependency is absent; gracefully omit only optional effects.

Gate: boot conformance plus invalid-output rollback, read-capability write detection in test fixtures, event upgrade fixtures, module-disable permutations and inverse tests against later conflicting changes.

### B06 - Exact financial and operational truth (P0 range checks; P1 domain depth)

Owner: accounting/inventory leads, with finance practitioner review.

Specify supported ranges for amounts, quantities, rates and aggregates. Use checked integer operations now; select bigint or fixed-scale numeric storage based on range tests and serialize exact values as decimal strings at JSON boundaries if they exceed JS safety. Keep currency scale, rational FX conversion, rounding mode, tax calculation basis and residual allocation explicit. Never mix transaction currency with base-currency thresholds without a pinned conversion fact. Changing base currency after postings requires migration policy, not a settings toggle.

Business completeness priorities:

- Bank statement import, matching and reconciliation; unmatched/suspense accounts; duplicates, fees, partial settlements, refunds, chargebacks and failed transfers. Recording a payment is not proof a bank settled it.
- AP controls: duplicate vendor invoices, three-way match tolerances, partial receipts, landed costs where needed, supplier bank-detail verification and segregation from payment approval.
- Close: subledger-to-GL reconciliation, lock ordering with posting, authorized adjustment periods, retained earnings and closing checklist evidence. Posted source snapshots preserve historical names/rates/terms.
- Inventory: concurrent reservation/fulfillment, negative-stock policy, lot/serial and expiry where segment requires, unit conversions, valuation rounding, returns after consumption and downstream correction plans.
- Master data: stable external IDs, duplicate merge with audit/redirects, effective dates, inactive counterparties and price/contract versions. Never delete a referenced posted record.
- Organization versus legal entity versus branch: document the initial boundary. If organization is tenant and legal entity today, enforce it. Add intercompany/consolidation only with elimination, currency and access rules plus demand.
- Tax/payroll/localization: publish supported countries, rule pack version/effective date, change review and test fixtures. Unsupported statutory outputs must be clearly ineligible; professional review is a release gate for a supported jurisdiction.

Gate: property tests plus reconciled scenario packs for each enabled segment, with overflow, zero/three-decimal currencies, partial returns, concurrent close/post, backdated changes and source-document history. A balanced ledger is necessary but cannot prove a business transaction was correctly classified.

### B07 - Imports, connectors, search and knowledge (P1)

Owner: integrations lead. Depends on B02/B03 and authorization scopes.

Imports are resumable jobs: upload quarantine → detect format → map fields → validate references/amounts → preview errors and counts → confirm scope → commit batches → reconcile totals. Store mapping version, source hash, row identity and per-row receipt. Support dry run, duplicate choices, correction file download, safe resume and compensating rollback for reversible records. Opening balances require an accountant-reviewed reconciliation; CSV parser coverage does not prove migration correctness.

A connector declares provider/account identity, read/write scopes, cursor/watermark, object mapping, conflict ownership, webhook verification, retry policy and reconciliation cadence. Use verified OAuth state/PKCE where appropriate, secret references and key rotation. Handle out-of-order/duplicate webhooks, missing pages, revoked credentials, token refresh races, deletion and backfill overlap. Provide an integration health view with last successful sync, lag and next recovery action. Start with one demanded bank/payment or commerce connector; avoid a generic marketplace before operational proof.

Knowledge items carry tenant + resource ACL, origin, trust class, evidence reference, effective/expiry dates, supersession and sensitivity. Retrieval filters before ranking and checks access again at use; search counts/snippets must not leak forbidden records. Employee-private memory must not become organization memory. Treat external documents, tool results and remembered text as data; they cannot grant instructions or promote themselves to policy. User corrections propose structured facts with review and provenance. Measure citation validity and stale-answer refusal separately from fluent answer quality.

Gate: replay an interrupted import with duplicate rows and changed mapping; totals reconcile; revoked connector cannot continue; poisoned document cannot authorize a tool; cross-tenant and same-tenant restricted-document probes return neither content nor metadata.

## 4. Autonomy that can be explained and enforced

### A01 - Product levels and mandates (P0 contract, P1 rollout)

These are Chaste product definitions, not an external standardized autonomy scale.

| Level | User experience | Execution authority | Release prerequisite |
|---|---|---|---|
| L0 Manual | People operate forms/tables; AI may be disabled. | Human permissions and business approval rules. | Core operations work without a model. |
| L1 Assist | AI reads, explains and prepares drafts. | Scoped reads and explicitly permitted draft writes; no new external commitment. | Citation/access tests and clear draft state. |
| L2 Supervised execution | AI prepares a multi-step plan; a person approves a bound plan or consequential steps. | Approval binds concrete scope, budgets, preconditions and expiry; changed terms require review. | Recovery, stale-approval, segregation and cancellation proofs. |
| L3 Bounded delegation | AI completes a named workflow inside an explicit standing mandate and escalates exceptions. | Short-lived service identity, allowlisted capabilities/resources, cumulative limits and revocation. | Shadow evaluation, production controls, kill switch, reconciliation and operator coverage. |

Do not ship an organization-wide “AI can do everything” toggle. A mandate names goal/acceptance condition, principal and owner, legal entity, eligible counterparties/resources, capability versions, allowed effect types, per-action and rolling aggregate limits, currency basis, daily/timezone window, concurrency, expiry, data destinations, approval policy, escalation SLA and spend/time budget. Authority is the intersection of current user rights, tenant policy, mandate scope, capability requirements and environment restrictions. Missing or conflicting inputs fail closed.

Identity changes, policy loosening, audit alteration and production code promotion remain outside ordinary operational mandates. Human operation still respects segregation-of-duties policy. Avoid automating money purely because each installment falls below a threshold: reserve aggregate exposure across concurrent child runs and related orders, including fees, pending commitments and unsettled external effects. Release a reservation only on confirmed failure/cancellation; reconcile unknown outcomes conservatively.

Gate: split a prohibited payment into small actions; use concurrent agents; change currency; enqueue then revoke the owner; attempt a new payee; exceed spend through model retries. All are refused or escalated according to the mandate with readable reasons.

### A02 - Meaningful approval and control (P1)

Bind approval to canonical payload, resource versions, policy/mandate revision, requester, approver identity, expiry and intended external destination. Recheck authority and invariants at execution. Approval is not a reusable bearer credential. Support maker/checker separation, scoped delegation, quorum for selected operations, out-of-office handover and rejection/cancellation permissions. Emergency access is time-bound, independently logged and reviewed; no silent bypass.

An approval preview shows what changes, amount/currency, counterparty, cumulative exposure, evidence age, risk, reversibility, missing data and expiry. Avoid “approve all” across materially different risks. On conflict explain exactly which terms changed and offer a refreshed proposal. Approvers can approve known independent steps while leaving an unresolved step blocked only when dependencies allow it.

Control scopes: pause a run, suspend a mandate, block a connector, stop tenant agent writes, stop fleet autonomous writes. Enforcement is server-side before every new effect. An in-flight irreversible effect may finish; report it and reconcile. Retain read access and manual operations when safe. Test controls across replicas and workers; targeting propagation within five seconds is a proposed engineering gate, not a present guarantee.

### A03 - Earned rollout and useful proactive behavior (P1)

Promote one workflow L1 → shadow → L2 → limited L3, per tenant and workflow version. Shadow records would-act decisions without external effects. Evaluate missed obligations as well as bad actions; a routine that always says no-action is not useful. Deterministic prechecks prevent unnecessary model calls, with sampled no-action audits to detect blind spots.

Use a benchmark of normal, ambiguous, adversarial, stale and partial-failure scenarios with held-out fixtures. Publish completion/denial/blocked rates, duplicate effects, reconciliation delay, intervention rate, operator time, spend per verified task and false/missed alerts separately. Start pilot targets at zero unauthorized/duplicate committed effects in the defined safety suite and at least 95% verified completion on explicitly in-scope tasks; report sample sizes and confidence intervals. Safety-suite success is not a statistical guarantee of zero production risk. A policy violation immediately suspends the affected workflow pending investigation.

## 5. Security, privacy and enterprise operation

### S01 - Tenant and identity boundary (P0)

Owner: security + IAM leads. Inventory shared/global tables, tenant tables and indirect child tables. Runtime DB role must be non-owner and `NOBYPASSRLS`; migration credentials are separate. Test `USING` and `WITH CHECK`, unset tenant context, pooled context reuse, background jobs, joins, foreign-key linkage, exports and cache hits. Use composite `(org_id, id)` references or equivalent checked constraints where cross-tenant linkage is possible. A global dispatcher may discover jobs with a narrow role but executes tenant work in tenant scope. Never “fix” worker failures by giving every worker superuser access.

Trace full SSO login rather than accepting configuration storage as completion: verified domain ownership, issuer/audience/recipient checks, request correlation, assertion replay prevention, certificate rotation, account linking and tenant selection. Test SCIM group mapping, disablement, session invalidation and queued mandate revocation together. Require suitable MFA/step-up for sensitive approvals; specify recovery and lockout to avoid stranding the last administrator. API/service identities need scoped expiring credentials, rotation, inventory and last-use visibility.

Gate: adversarial two-tenant integration matrix under actual runtime roles; stale session after deprovision; malicious account-link and cross-org invitation; unauthorized approval/rejection. Fail release on boundary failures even if all unit tests pass.

### S02 - Untrusted data, secrets and external boundaries (P0/P1)

Owner: application-security lead.

Use OWASP ASVS as a review checklist and the OWASP GenAI excessive-agency guidance for tool scope; authorization remains deterministic. Scan uploads with size/count/type limits, quarantine active content, protect archive expansion, sanitize generated HTML/Markdown and CSV exports (formula execution), and enforce download authorization. Test SSRF with redirects, DNS rebinding, private/loopback/link-local addresses and cloud metadata destinations; an allowlisted hostname alone is insufficient. Verify webhook signatures over original bytes, timestamps and replay IDs before enqueueing.

Secrets remain encrypted references, never model context, client bundles, generic logs or proposal fixtures. Use environment-specific KMS/key ownership, least-privilege retrieval, rotation/revocation and a redacted diagnostic bundle. Define a model egress policy by data class and provider/region; fallback cannot silently route sensitive data to a less-trusted provider. Rate-limit by authenticated principal/tenant as well as verified network source; enforce aggregate model spend and bounded uploads independently of per-process counters.

Gate: inject malicious instructions into documents/memory/tool outputs; request forbidden exports; leak seeded canary secrets through errors; spoof forwarded headers; rotate a connector secret during a retry. Assert actual effects and egress, not just an assistant refusal string.

### S03 - Retention, audit credibility and recovery (P1)

Owner: operations + security; privacy/legal review for customer commitments.

Keep immutable financial/audit facts minimal; store sensitive payloads separately with access and retention controls. Define retention per data class, legal-hold behavior, tenant deletion/export, backups and provider traces. Where payload deletion is allowed, retain a digest/tombstone and explicitly downgrade deterministic replay; “keep all model prompts forever” conflicts with data minimization. Hash chains detect tampering only relative to a trusted checkpoint: periodically anchor signed chain heads in separately controlled storage and verify restores against them. Do not claim that a database administrator cannot rewrite an unanchored chain.

Deliver encrypted backups, point-in-time recovery, restore automation, regional placement documentation, capacity alerts, database migration runbooks, incident response, security contact, access review, audit export and support escalation. Restore into an isolated environment with dispatch and outbound connectors disabled until reconciliation prevents replayed outbox sends. Run synthetic recovery drills including corrupted/missing backup segments and lost keys. Initial pilot design targets: RPO ≤15 minutes and RTO ≤4 hours; measure before contractual promises.

Pin deployment images and dependencies, generate SBOM/provenance, scan secrets/dependencies, minimize CI token permissions and separate fork/untrusted builds from secrets. Use expand/backfill/validate/contract migrations, lock timeouts and resumable batches. Rollback an application image only when schema compatibility is proven; irreversible data migrations need forward repair. Do not equate SOC2-style mapping with certification or a security checklist with compliance.

## 6. Human experience before visual polish

### U01 - A shared work surface (P1, delivered with durable runs)

Owner: product + UX leads. Default experience depends on job, not technical skill: owner sees cash/obligations and approvals; operator sees today's tasks and exceptions; accountant sees reconciliation/close; administrator sees access and health. Offer progressive disclosure and saved views instead of duplicating separate products for beginners and experts.

Forms, tables and conversation manipulate the same draft and receipt. A request such as “order enough for next week” opens a structured proposal with assumptions and editable quantities; a table edit updates the plan revision. Show agent activity beside the affected business record. Users can take over, correct a field, assign an exception or pause the mandate without losing state. Do not force chat for ordinary repetitive work.

Create a unified work inbox for approvals, exceptions, missing information and failed integrations, with owner, due time, business impact and next action. Deduplicate related signals; distinguish information from required action. Keep successful no-action routine ticks quiet. Escalate unowned overdue obligations and provide a digest/quiet-hours policy. Avoid optimistic “Paid” or “Completed” labels before a receipt confirms them.

Gate: test five tasks with novice, operator and accountant participants: find overdue obligation, review a proposal, correct an agent, recover a failed action and explain the final business state. Record completion, errors, assistance and time; proposed pilot target ≥90% unassisted completion on each critical task after iteration. Automated browser tests cover permissions and durable state transitions; usability claims require observed participants.

### U02 - Onboarding that creates first value (P1)

Build on the existing wizard and remote tests. The minimum first session creates a workspace, confirms accounting-critical defaults and produces one useful, safe result. Rich business description, imports, team invitations, branding, connectors and agent/provider configuration can wait.

| Step | Experience and persisted output | Skip/setup-later behavior |
|---|---|---|
| Welcome | Choose role and immediate job; fresh/import/connect plus a separate sample workspace. Explain the short path. | Optional role/detail questions have sensible defaults. Sample data is visibly separate and never mixed into live books. |
| Workspace essentials | Name, locale, timezone, legal jurisdiction where needed and base currency; explain choices that become hard to change. Server validates supported currencies. | Descriptive profile can be skipped. Financial prerequisites block posting, not exploration or drafting. |
| Business fit | Suggest modules and starter chart/workflow from industry/goal; preview assumptions for confirmation. | Store incomplete configuration and expose it at the first dependent action. Do not silently invent tax registrations or bank accounts. |
| Bring data | Upload preview, mapping, duplicates and opening-balance reconciliation; show background progress. Only offer live connectors that actually work. | Save draft mapping, defer safely, resume after reconnect. Unsupported connectors are labelled with a manual alternative. |
| Collaborate and control | Invite with clear roles; show L1 default and a concrete L2 example. Sensitive access remains governed. | Invite later; no default broad autonomy or unnecessary API-key requirement. |
| First result | Guided first draft invoice, stock view or cited business summary based on real available inputs. Link to record and explain next step. | Finish basic onboarding while preserving a quiet setup checklist with owners and contextual reminders. |

Persist draft state server-side after authentication, version it, save each step idempotently and resume across refresh/session expiry/device changes. Protect sensitive drafts on shared devices; clear local state on logout/tenant switch. “Skipped,” “not applicable,” “in progress” and “blocked” are distinct. Completion never erases deferred work. Avoid creating a notification for every retry or displaying an impossible progress percentage.

Backend corrections: move embedding to a post-commit job; make bootstrap receipt retrievable after network loss; handle slug uniqueness conflicts in the transaction; merge setup fields atomically or with expected version; separate onboarding completion from first-posting readiness. Remove unsupported statements that the model “never asks again” or must guess when a profile is absent.

Gate: fresh/import/connect, mobile/keyboard, slow network, duplicate submission, provider absent, import partial failure, concurrent setup tabs, logout/return, invited user and multi-org user. Every optional step can be deferred and resumed; required posting prerequisites cannot be skipped into unsafe execution. Proposed research target: useful first draft within five minutes for the fresh path, reported separately from imports and compliance setup.

### U03 - Error, recovery and trust language (P0 semantics, P1 surfaces)

Every failed action answers: what happened, whether anything changed, what to do next, and a safe support reference. Use codes such as `validation_failed`, `permission_denied`, `stale_approval`, `version_conflict`, `dependency_unavailable`, `budget_exhausted`, `outcome_unknown` and `internal_error`. Localize user text while retaining stable machine codes. Retry affordances follow the result contract, never substring matching an exception.

Keep form input, mark fields, focus the first error and show a single action status. Distinguish saved draft, requested, waiting approval, running, committed, settled externally, failed and needs reconciliation. Reconnect streaming from a durable cursor; a disconnected chat is not a cancelled run. Display last update/freshness and current responsible actor. Diagnostic expansion contains sanitized details, not raw API bodies, SQL, filesystem paths or credentials. Cancellation explains already committed consequences.

Gate: inject errors from every boundary and assert both business state and rendered recovery action. Screen-reader announcements do not repeat every streamed token; approval and outcome changes are announced once.

## 7. UI system and interaction quality (P1/P2)

Owner: UI engineering + design. Preserve the existing brand/token primitives initially; audit actual screens before choosing a visual redesign. The source review above is not a visual audit.

Create shared patterns for page heading/actions, filters, data table, detail panel, draft editor, approval comparison, receipt, empty/loading/error/permission states, background progress and exception cards. Keep consistent labels and placement across modules. Dense tables need column selection, saved filters, server-side sorting/pagination, sticky headers, keyboard selection, accessible bulk actions and export progress. Show currency/unit/timezone with values, align decimals and expose rounding/source details where relevant.

Use colour plus text/icon for status, visible focus, predictable tab order, reduced motion, zoom/reflow, accessible contrast and adequate target sizes. Target WCAG 2.2 AA with automated checks plus keyboard and screen-reader review. Mobile prioritizes approvals, capture, stock lookup and daily tasks; wide financial grids may use a deliberate condensed detail view. Support long names, non-Latin text, right-to-left layout readiness and locale-aware dates/numbers without silently changing stored values.

Approval/agent panels should communicate result and evidence, not raw reasoning. Skeletons match layout; preserve scroll/filter state after navigation. Destructive controls describe consequences; exact undo is shown only when valid. Bulk actions preview affected scope and individual failures. Avoid a global dashboard that mounts every module and every expensive query.

Gate: verify initial load and client navigation with the repository's `next-dev-loop` skill, then keyboard/screen-reader and responsive checks at narrow/wide widths, zoom and large datasets. Guard prioritized routes with version-matched `instant()` tests. Visual snapshots cover representative states; screenshots alone are not proof that a task works.

## 8. Developer experience, code conventions and removal work

### D01 - Reproducible local setup (P1)

Owner: developer-platform lead. Provide one documented bootstrap command and a read-only `doctor` command: supported Node/pnpm versions, Docker health, ports, database extension/migration state, non-owner runtime role, required secrets by mode, provider connectivity and actionable repair guidance. Respect a running server; never start duplicates or reset a developer database silently. A fresh clone with a frozen lockfile must start app + worker + synthetic data and run a governed demo without a provider key through a deterministic development adapter.

Separate `demo`, `development`, `test` and production configuration; reject test authentication/fixtures in production. Generate local secrets without printing them; document model optionality, operating system assumptions, proxy requirements and recovery from port collisions. A dev container is optional; ordinary CLI setup remains supported. Detection of a coding agent refers to the host where detection ran, not automatically the user's browser machine. Remote/self-hosted setups need an explicit agent connection contract.

Gate: a clean environment following only README completes setup, migration, login, first draft, worker task and tests. Test a second documented setup environment; report unsupported hosts rather than invent portability. Missing provider key should degrade AI features with a clear status while deterministic ERP flows remain usable.

### D02 - Boundaries and intentional cleanup (P1/P2)

Use Zod at external boundaries, pure domain functions in `erp-core`, IO repositories in modules and authority in kernel. Replace `services: Record<string, unknown>` incrementally with typed service keys for the services that matter; avoid a dependency-injection framework until lifecycle needs justify it. Share browser-safe onboarding schemas/types instead of mirrored step lists. Normalize errors and results before extracting generic UI factories.

Large module `index.ts` files should become capability groups plus repositories and pure helpers when a change needs that seam. Avoid a broad “cleanup sprint” without behavior evidence. Identify dead exports/dependencies with static tooling, then confirm dynamic registry/plugin/string-ID usage before deletion. Start removal candidates with duplicate onboarding types, exception-text dispatch, misleading comments/claims, generated placeholder tests treated as evidence, unused adapters and duplicate posting logic if any remains. Nothing is declared dead solely from this review.

Add boundary lint rules, canonical money/date/ID utilities, explicit clock injection in deterministic tests, documented nullability and stable naming (`module.action`). Keep required explanatory comments for unsafe casts; retire broad casts as interfaces improve. Regenerate lockfile for dependency changes. Record behavior changes in CHANGELOG and significant accepted decisions in new ADRs; never rewrite history to match a new design.

Gate: each deletion names callers/dynamic registry checks and focused regression proof; each extraction reduces a demonstrated source of drift without changing receipts/policies. Reviewers can locate schema → capability → domain invariant → test → human surface from one capability catalogue entry.

## 9. Performance and operating economics

Owner: performance + runtime leads. Measure before tuning; targets below are proposed pilot budgets on a declared deployment profile, not current measurements.

| Workload | Initial target | Measurement and integrity constraint |
|---|---|---|
| Governed local mutation, excluding approval/provider delay | p95 ≤500 ms, p99 ≤1.5 s | End-to-end server latency; measure authorization, locks, transaction and audit separately. No audit bypass for speed. |
| Bounded list/detail query | p95 ≤300 ms server time | Indexed tenant-scoped pagination; report warm/cold cache and dataset distribution. |
| Interactive job queue delay | p95 ≤2 s below admitted load | Separate from execution and human waiting; enforce fair tenant admission. |
| User input response | p75 INP ≤200 ms | Real-user measurements segmented by device/network; long tasks and table rendering profiled. |
| First main content | p75 LCP ≤2.5 s; CLS ≤0.1 | Hard navigations measured separately from prefetched navigation. |
| Model use | Spend per verified task and cached-input ratio | Include retries, embeddings, silent routines and failed tasks, not only successful turns. |

Create a reproducible load fixture initially with 100 tenants, one large tenant with 1 million journal lines and 100k items, 50 concurrent interactive clients, scheduled bursts and ingestion traffic. These are test inputs to refine after discovery, not asserted production capacity. Report hardware, DB/pool settings, data skew, throughput, percentiles, error rate and lock waits. Saturate deliberately to prove bounded degradation and no tenant starvation.

Tuning order:

1. Instrument request → run → action → transaction → outbox → provider correlation using the existing structured logger seam and OTel export. Keep tenant/run IDs out of unbounded metric labels; sensitive text is not a trace attribute.
2. Remove external calls from DB transactions (onboarding embedding is concrete first work). Inspect `EXPLAIN (ANALYZE, BUFFERS)` in a safe fixture for expensive reads; add tenant/order/filter indexes based on actual plans. Bound queries, exports, signal producer work and payload sizes.
3. Size aggregate DB connection pools across web replicas/workers against database capacity; add statement/lock/idle transaction timeouts. Background work must yield to operational writes. Queue claiming needs a writable primary; an ordinary read replica cannot host the writable queue. Only stale-tolerant analytical reads move to replicas.
4. Measure global ledger lock waits; apply ADR 0022 per-tenant chain heads with migration verification. Partition/archive only after measured growth/maintenance needs. Do not repeat ADR prose asserting the global lock will be tolerable for years without evidence.
5. Build rebuildable read projections for expensive dashboards, with visible freshness/high-water marks and catch-up. Financial execution reads authoritative current state; caches/projections cannot authorize a payment.
6. Apply Next Cache Components/Suspense and navigation patterns from the installed Next docs. Cache scope includes tenant and applicable permission/policy version; invalidate after mutation and access revocation. Test warm cache after tenant switch, logout and privilege downgrade. Virtualize only when row measurements justify complexity.
7. Select tools/context by task, keep stable prefixes, compact structured facts with citations and pending controls, cap model fan-out and reserve token spend. Provider timeout/fallback policies must preserve data-residency and model capability constraints.

Gate: before/after runs on identical fixture with sufficient repetitions, correctness assertions under load, no duplicate effects and measured improvement without a meaningful regression elsewhere. Record unresolved bottlenecks rather than extrapolating a single laptop timing.

## 10. Continuous self-development as an operated delivery system

### E01 - Two distinct learning loops (P1)

Owner: creator-platform lead, with separate security and release owners.

Operational learning improves explicit tenant configuration, retrieval facts and approved workflows. Product development changes tested artifacts. Neither loop silently edits model weights, grants itself permissions or treats repeated suggestions as authorization. A successful user action can suggest an SOP; it does not automatically become policy.

Intake sources: reproducible missing capabilities, user corrections, recurring exceptions, task-verifier failures, privacy-preserving aggregate friction, performance regressions and dependency/security advisories. Deduplicate by behavior/root cause, link affected versions and business impact, distinguish support/configuration gaps from code defects, and assign a budget/owner before building. Continuous means scheduled, bounded, observable cycles with a stop condition-not an infinite self-triggering agent.

Lifecycle: observed → triaged → specified → fixture_ready → building → verifying → review → candidate → staged → promoted → observing → validated. Explicit side states: needs_information, rejected, blocked, failed, cancelled, superseded, rolled_back. “Validated” requires a post-release acceptance outcome; promotion alone does not close a feature gap. Track lead time, verified resolution, recurrence, rollback frequency, review burden and total cost; code volume is not success.

### E02 - Contract and verifier integrity (P0 for credible evidence; P1 pipeline)

A change contract includes user outcome, non-goals, actor/resource scopes, invariants, touched entry points, forbidden bypasses, compatibility/migration needs, performance budget, adversarial fixtures and required UX observables. Freeze its revision before coding. The author may propose tests; an independently controlled verifier runs baseline and candidate against held-out tests and unchanged mandatory gates. A candidate cannot relax tests, change a gate expectation, replace the test runner or alter CI policy and still certify itself.

Represent evidence as typed artifacts: `proposed_test_source`, `execution_result`, `manual_review`, `security_review`, `release_observation`. An execution result records source commit/tree digest, dirty-tree state, lockfile digest, runner/image/toolchain digest, command, exit code, environment class, timestamps, test counts including skipped, artifact/log digests and verifier identity. Bind signatures to the actual candidate and migration digests. If the diff changes, relevant evidence expires. A passed `expect(true)` or a string containing “all tests passed” is not evidence of a business outcome.

Apply unlazy discipline in implementation: inventory independently omittable outcomes; gates before work; narrow file ownership; implementation/expert reread/defect hunt/polish; parent re-verification against actual artifacts; explicit unmet/abandoned handoff. Gate commands are executable code: inspect and authorize them under normal project permissions, run untrusted checks in isolation, and do not let a generated ledger approve itself. The ledger records proof; it cannot prove its own English contract was sufficient.

Gate: submit a proposal with fabricated logs, stale source digest, deleted failing test, changed CI runner, only skipped tests, placeholder assertion and malicious gate command. Each fails the appropriate verifier without gaining host authority. A legitimate change demonstrates a failing baseline regression and a passing candidate outcome.

### E03 - Isolation and least-privilege exchange (P1)

Production emits a sanitized, tenant-scoped gap envelope through an authenticated outbox. Development consumes only approved fixtures, not a production DB credential. Export approval checks re-identification risk and actual attachment contents; sanitization is not proven by a filename. Begin with synthetic fixtures; minimal redacted exports require explicit policy/approval and expiry.

Use ephemeral isolated runners for untrusted generated code: no host filesystem mounts, Docker socket, production secrets, broad cloud metadata access or shared writable caches. A worktree is not a security sandbox; an ordinary container alone is not sufficient proof against hostile code in a multi-tenant service. Choose a hardened container/VM boundary based on the threat model, resource limits, egress controls and escape tests. Separate dependency-fetch/build phase from no-network test execution where feasible; approved registries/provider gateways get narrowly scoped access, with pinned dependencies and supply-chain inspection.

Treat repository instructions, fixtures and build output as untrusted input to the development agent. Subprocess tools expose bounded commands/filesystem scopes; test output cannot request secrets or change deployment policy. Wipe runners after evidence collection. Deduplicate/retry envelopes by gap/contract revision; expiry and tenant suspension apply during retries.

Gate: synthetic malicious proposal attempts egress, host traversal, symlink escape, resource exhaustion, production credential retrieval and cross-job cache poisoning; none crosses the selected boundary. Kill/retry the build without duplicate promotion or leaked fixture data.

### E04 - Promotion, rollback and real learning (P1/P2)

Separate principals for authoring, verification, artifact signing and production deployment. Human code review and protected CI govern platform merges; tenant administrators enable tenant-scoped functionality but cannot approve shared platform code for every tenant. A production runtime has no source-write/package-install authority. Auto-remediation is initially restricted to preapproved reversible configuration/workflow actions, never self-expanded release permissions.

Promote the exact verified artifact digest through review environment → opted-in canary tenant/cohort → wider release. Require independent reviews for authentication, permissions, money, migrations and verifier/deployment changes. Compare errors, latency, business invariants and acceptance outcomes; stop on threshold breach. Low traffic may be inconclusive: remain under observation or require human decision instead of declaring success.

Rollback distinguishes application version, tenant configuration, workflow version, plugin version and data compensation. Backward-compatible schema windows precede canary; incompatible migrations need rehearsed forward recovery. Re-running historical workflows after deployment needs pinned capability/schema compatibility and fresh authority. A release rollback does not erase already-sent messages or reverse posted money automatically.

After rollout, link verified outcomes to the original gap, collect explicit user feedback, check recurrence over an agreed observation window and update documentation/evals. If unresolved, reopen with evidence; do not create an endless cycle of near-identical proposals. Enforce per-tenant/fleet cycle budgets, maximum attempts, cooldowns, concurrency, prioritization and an operator pause. The owner can cancel development without losing the underlying feature request.

Gate: reject one candidate; revise it and invalidate old evidence; approve another; inject canary regression; stop and recover; then prove a successful candidate resolves the original contract. A development agent cannot approve its own code or promote through an ordinary ERP capability.

## 11. Edge-case acceptance matrix

Each row becomes an executable fixture where practical, owned by the named workstream. A table entry is a requirement, not a passing test.

| Scenario | Required observable outcome | Owner |
|---|---|---|
| Commit succeeds, response/audit network path fails | Receipt reveals committed state; same intent does not duplicate. | B02 |
| Two workers claim one due recurring invoice | One occurrence and one invoice; loser references existing outcome. | B03 |
| Lease expires; old worker returns after replacement | Fencing rejects stale commit; external unknown is reconciled. | B03 |
| Approval expires or bank account changes | Original approval cannot execute changed terms. | A02 |
| Approver loses role while a job waits | Recheck blocks execution and assigns a resolvable exception. | A01/S01 |
| User cancels during provider timeout | Show unknown/committed effects, stop later actions, reconcile. | B04 |
| Two agents spend remaining daily budget | Atomic reservations enforce aggregate ceiling. | A01 |
| Same idempotency key with another payload/principal | Conflict or denial; no prior sensitive result disclosed. | B02 |
| Currency overflow, fractional units, FX rounding | Checked exact arithmetic or clear refusal; reconciled totals. | B06 |
| Close races with backdated posting | Defined serialization order; closed-period invariant holds. | B06 |
| Undo after downstream fulfillment/period close | Refuse exact undo; propose valid compensating sequence. | B05/B06 |
| Module disabled during a workflow | Mandatory dependency blocks; optional effect is visibly omitted. | B05 |
| Poisoned knowledge or old permission cached | No authority change or forbidden retrieval, including snippets. | B07/S01 |
| Onboarding duplicate request/multi-tab edit | One intended workspace; no lost setup state or false reassurance. | U02 |
| CSV malformed/large/formula-bearing/duplicate | Bounded validation, safe export and row receipts; resume reconciles. | B07 |
| IdP disablement during autonomous work | Sessions and delegation cease; no new effect after revocation gate. | S01 |
| Restore contains already delivered outbox events | Dispatch quarantined until provider/internal reconciliation. | S03 |
| Tenant A saturates ingestion and ledger | Tenant B retains admitted service; fairness and lock metrics show it. | B03/PERF |
| Candidate modifies acceptance gate or steals runner token | Verification rejects; runner cannot escalate privilege. | E02/E03 |
| Canary schema newer than rollback image | Compatibility gate prevents unsafe rollback; forward repair rehearsed. | E04 |
| Model unavailable or budget exhausted | Manual ERP works; run waits/blocks visibly without retry storm. | D01/A03 |
| Event payload legally removed/observation missing | Audit metadata remains where permitted; replay states its limitation. | S03 |

## 12. Delivery programme and acceptance ownership

Priority means dependency/risk, not a promise to build every feature immediately. P0 blocks paid operational autonomy; P1 enables the first enterprise pilot; P2 is proven-demand expansion. Estimates should follow baseline sizing; calendar dates here would imply evidence we do not have.

| Wave | Deliverables | Dependencies | Accountable owner | Exit evidence |
|---|---|---|---|---|
| W0 Baseline and product contract | F01–F17 reproduction/triage; runtime role/entry-point inventory; target customer/jurisdiction; current demos/latency; pilot SLO proposal. | None | Architecture + product leads | Evidence register with confirmed/ruled-out/open states, no unsupported GA claims, scoped first workflow. |
| W1 Integrity and immediate security | B01/B02; F04 recurring fix; F08 risk/evidence correction; output/result contract; critical S01/S02; money range guard. | W0 | Kernel + DB + security | Atomic effect/audit tests, duplicate/authorization/range negative cases, existing regression suite. |
| W2 Durable execution and recovery UX | B03/B04, A01 contract, receipt/exception surfaces, U03, first D01 improvements. | B02 identity + tenant authority | Runtime + product engineering | Fault-injected order/reorder workflow, lease recovery, stale approval and cancellation; no ghost completion. |
| W3 Enterprise supervised pilot | B05/B06 selected domain controls, A02/A03 L2, B07 one connector/import, U01/U02/UI, S03 restore. | W1/W2 | Domain + UX + operations | Human/agent parity, usability study, reconciled imports, real browser tests and restore drill; declared supported segment. |
| W4 Bounded L3 operation | Mandates/budget reservations, shadow benchmark, fair scheduling, observability/performance hardening. | W3 plus pilot evidence | Runtime + security + operations | Revocation/kill-switch proof, held-out task evaluation and monitored cohort; release owner authorizes workflow eligibility. |
| W5 Verified development loop | E01/E02/E03, canonical run evidence/replay subset, proposed composition adapter only if needed. | W1/W2 contracts; S02 isolation | Creator + security + developer platform | A real regression fixed in isolated candidate with independent evidence and no production access. |
| W6 Controlled evolution release | E04, canary/rollback, user-facing evolution progress, follow-up measurement. | W5 plus S03 release/restore | Release + product owners | Exact artifact promoted through human/CI boundary; rollback drill and original gap validated. |
| W7 Expansion | Additional localization/connectors, complex manufacturing, multi-entity, marketplace and composition sophistication. | Customer demand + readiness evidence | Product + domain leads | Per-feature business/operational gates, no blanket enterprise claim. |

W5 preparation can overlap W3 after the shared execution/evidence interfaces stabilize; W4 and W6 are separate authorities. Neither depends on granting the other broader permissions. Avoid parallel edits to shared executor/schema until a migration owner fixes interfaces and file ownership.

### First operational proof: shortage to approved purchase order

Use a synthetic tenant with one warehouse, an approved supplier, three stock items, known demand/lead times and an explicit replenishment budget. A deterministic stock signal identifies a shortage. The agent prepares a PO using the existing reorder math, cites the inputs and records a durable acceptance contract. A person changes one quantity and approves the revised proposal. Execute through the kernel; crash the worker after commit but before acknowledgement. On resume, show the original PO receipt rather than create another order. Change supplier terms before a second approval and demonstrate stale-precondition refusal. Disable the mandate and prove a queued third proposal cannot execute.

The acceptance predicate independently queries the authorized tenant's records: one PO for the approved intent, lines matching the approved revision, exposure within the budget, no unintended financial posting, a linked approval/effect/audit record, and a terminal run state with the same receipt shown in the UI. Record draft-only or committed order semantics precisely; this proof does not claim goods were delivered or a supplier was paid. Run through manual and agent adapters, then with a provider timeout, a competing reservation and a restricted user. A finance/inventory reviewer checks the fixture's business meaning before this becomes a release gate.

The first development proof then uses a separately specified missing behavior from that workflow. The independent runner demonstrates the old behavior fails its regression fixture, the candidate succeeds, and the candidate cannot weaken policy, change the verifier or reach production. Human review and exact-artifact staging precede post-release validation, following E01–E04 and the original plan's development slice.

### Initial engineering tickets ready for refinement

| Ticket | Concrete change and proof | Dependency |
|---|---|---|
| T01 | Add controlled reproducer for committed write + failed audit and capture actual receipt ambiguity; no production fault injection. | W0 fixture DB |
| T02 | Implement one transaction-aware effect/audit/payment receipt path; adapt existing payment demo and duplicate tests. | T01, B02 design review |
| T03 | Reproduce recurring claim race with two workers, then unique occurrence + idempotent invoice generation. | B02 identity contract |
| T04 | Split creator rendering from proposal submission; replace ambiguous evidence text with typed provenance and migrate legacy rows as unverified source. | F08 validation |
| T05 | Central decision authority for approve/reject, stale-resource checks and recoverable executing receipts. | T02, route authorization inventory |
| T06 | Add lease/fencing/backoff and crash fixture to one job type; migrate other types with explicit waiting states. | T02/T03 |
| T07 | Durable run + reconnect/cancel UI on one cross-module task, including tool/version and contract revision. | T06 |
| T08 | Bootstrap intent receipt, async embedding, atomic setup state; extend incoming wizard tests for response loss and resume. | T02/B01 bootstrap contract |
| T09 | Runtime role/tenant matrix, including creator/search/export and worker delegation revocation. | W0 inventory; T02 |
| T10 | Independent creator verification runner with adversarial false-evidence fixtures and exact candidate digest. | T04, S02/E03 design |
| T11 | CI demo manifest separating deterministic DB scripts from provider tests; report skips and run affected full-story proofs. | W0 demo classification |
| T12 | Baseline load/trace fixture and measured first optimization; preserve integrity assertions under contention. | T02/T06 |

### ADR queue

Create proposed ADRs during implementation design review, using the next available number (0041 was available at this review): transaction-aware effect receipts; mandate/segregation model; durable jobs and fencing; event/replay retention; exact monetary ranges; creator verifier trust and isolation; runtime profile/composition adoption if demonstrated. ADR 0022 needs an explicit implementation/migration decision, not deletion. ADR 0023 needs updated threat/evidence wording: a sandbox does not make all exfiltration structurally impossible, and a recorded installation is not executed conformance proof. ADR 0032's replica suggestion must distinguish read workloads from writable queue operations.

## 13. Release gates and evidence policy

Every implementation ticket supplies a contract, paths/owner, dependencies, failure cases, observable oracle, migration/rollback and user-visible result. Engineers write unlazy gates before implementation and perform all four review passes. A code author cannot report a whole milestone done because a narrow leaf test passed.

Required baseline command: `pnpm typecheck && pnpm lint && pnpm test`. Additionally run affected live DB demos and full-story browser tests, with migrated fixture DB and provider credentials only where needed. Never connect destructive fault tests to a production database. CI must publish test counts, failures and skips, include deterministic financial/governance proofs without a model key, and require separate live-provider evidence for claims about agent behavior. Use isolated per-run fixture databases and job namespaces; tests must not drain a shared global queue or depend on another suite’s schema setup. The planning baseline currently has a product-suite setup timeout and a queue-test database-query failure; W0 must reproduce and resolve them before a green baseline is claimed. RLS probes use a non-owner role. UI work follows the repository's Next runtime verification agreement; performance work adds repeatable navigation/load guards.

Acceptance packet for a pilot release: exact commit/image/migration digests; pass/fail/skip inventory; supported workflows and jurisdictions; security threat/review findings; restore/reconciliation drill; operator runbooks and owner coverage; usability outcomes; load profile/results; remaining risks and explicitly disabled features. A blocker can be documented but cannot be counted as passed. Exceptions need a named risk owner, bounded scope and expiry; fundamental tenant/financial authority failures are release blockers.

Business continuity depends on people too: name on-call coverage, support severity and response expectations, incident communication, customer training, data migration owner and rollback decision maker. Measure value by verified work completed, time reclaimed and fewer unresolved obligations, balanced against error, review and compute costs. Do not optimize agent autonomy as an end in itself.

## 14. Decisions to resolve during discovery, with safe working defaults

| Decision | Working default for planning | What changes after customer evidence |
|---|---|---|
| First customer segment | One trading/distribution or service-business pilot, chosen by access to real users. | Domain readiness and onboarding templates; do not build every vertical. |
| Deployment | Single-region modular app + dedicated workers + PostgreSQL; select region per customer requirement. | Residency, availability, backup and network design after contractual needs. |
| Initial autonomy | L1 by default; L2 for tested workflow; L3 opt-in only after mandate gates. | Workflow/counterparty/amount eligibility based on observed outcomes. |
| Finance scope | Explicit supported entity/currency/jurisdiction, practitioner-reviewed. | Localization and consolidation investment based on demand. |
| Extension scope | Declarative config/workflows before executable tenant plugins. | Sandbox/isolation and support costs justify a plugin tier. |
| Delivery capacity | Size W0/W1 first; assign actual leads before implementation scheduling. | Estimates and parallel ownership reflect team and migration complexity. |

These decisions do not block documenting the design. They block unsupported product promises and unsafe rollout choices.

## 15. Reference basis and review limits

Repository authority: [ARCHITECTURE](../ARCHITECTURE.md), [ROADMAP](../ROADMAP.md), the original Cordis plan, ADRs 0020–0023/0032 and source paths in §2. Framework performance guidance was checked against the locally installed `apps/web/node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md`; implementation must consult the relevant bundled guides again for its installed version.

External primary references checked 2026-09-10:

- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): owner/bypass-role behavior supports S01's deployment-role verification requirement.
- [OWASP excessive agency](https://owasp.org/www-project-top-10-for-large-language-model-applications/2_0_vulns/LLM06_ExcessiveAgency.html): supports minimizing tool functionality, permissions and autonomy; Chaste mandate semantics are this proposal's design.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): accessibility target for UI acceptance; conformance is not claimed by this plan.

All numerical service, quality and onboarding goals are proposed starting gates. No production capacity, usability outcome, compliance status, model superiority or upstream source compatibility has been established in this planning review. Verification of this documentation change is recorded in [ENTERPRISE_PLAN_REVIEW.md](ENTERPRISE_PLAN_REVIEW.md).


## 16. Product systems follow-up (2026-09-11)

The [Product Systems Addendum](ENTERPRISE_PRODUCT_SYSTEMS_ADDENDUM.md) is part of this programme. It adds X01–X20: actor/delegation attribution; operational and coding-agent skills; capability discovery; automation/workflows; goods/services; structured questions and receipt links; graceful AI controls; private telemetry and voluntary diagnostics; useful gap handling; analytics/report provenance; recovery codes; assisted mapping; private prod/dev transport; multimodal files; Neon/Supabase profiles; public intake/HR lifecycle; and document evidence automation.

Its evidence review confirms that `ask_user`/AskCard, basic human-versus-agent attribution, skill find/load and public support/portal primitives already exist. It identifies additional priority reviews for direct import writes and currency parsing, public visitor identity, stale document derivations, and unverified report rows. X09 clarifies the default: permitted L1 assistance on, optional per-feature opt-out; L3 execution and external diagnostic sharing retain separate authorization. Follow the addendum's wave mapping and acceptance journeys alongside §§12–13 above.


## 17. Broader module audit and everyday product experience (2026-09-11)

The [Enterprise Module Audit](ENTERPRISE_MODULE_AUDIT.md) extends this programme with coverage of all 19 current module directories, 36 source-grounded findings/investigations, and 12 focused product hypotheses. It deepens read authorization, verified identity, public support, financial compensation, stock/production/payroll consistency, delivery truth, testing coverage and daily usability. Its implementation sequence maps to W0–W7 and includes migration, concurrency, route/browser and release proofs. These are proposed fixes, not shipped behavior or enterprise certification.

Per the user's clarification, unlazy discipline is specified for the **coding agents implementing the plan**; this review's prose/checklists are not a substitute for their independent executable evidence.
