# Product systems addendum: identity, skills, workflows and business evidence

Status: proposed extension to [Enterprise Evolution Plan](ENTERPRISE_EVOLUTION_PLAN.md).  
Date: 2026-09-11. Source baseline: `1f3b078`; existing local documentation/asset work preserved.  
Purpose: answer the follow-up questions with implementation evidence, decisions, ownership and acceptance criteria. “Not found” means not established in the inspected paths, not proof of absence from every dependency or deployment. No feature described below is implemented by this document.

## Decision summary

| ID | Question | Current position and recommendation |
|---|---|---|
| X01 | Can we distinguish a person from their agent? | Partly: interactive actors use the same user ID with different human/agent type. Add full delegation and approval provenance. |
| X02 | Internal business skills | Find/load playbooks exist; version, validate and correct their domain guidance. |
| X03 | Skills for the module-building coding agent | Repository skills focus on Next.js; add a Chaste-specific development pack and independent verifier. |
| X04 | Newly added capabilities become discoverable | Registered capabilities become model tools subject to permissions/modules. Release registration, discovery index and refresh need an explicit contract. |
| X05 | Odoo-like automation and workflows | Routines, recurring work and domain lifecycles exist; a general governed trigger/condition/action designer is not established. Add it over durable execution. |
| X06 | Tangible goods versus services | No explicit discriminator in the inspected item schema. Treat this as a core domain gap. |
| X07 | Questions rendered as chat components | Already present: `ask_user` and `AskCard`. Harden durable answers and dependency suspension. |
| X08 | Direct links to created records | No universal typed result-link contract established. Add receipt cards and stable authorized resource routes. |
| X09 | AI on by default, individually switchable | Configuration visibility and module toggles exist; introduce independent AI feature controls with graceful shutdown. |
| X10 | Useful telemetry without private data | Existing token metrics are not a privacy-designed product telemetry system. Separate aggregate metrics from voluntary diagnostic submissions. |
| X11 | Missing capabilities leave users stranded | Ticket fallback exists, but returns only “ticket filed.” Add actionable alternatives, status and ownership. |
| X12 | Analytics experience | Existing typed extractors and explanations are a good base; add trusted metric definitions and drill-through exploration. |
| X13 | Reporting | HTML/SVG report rendering exists; add verified dataset provenance, saved/versioned reports and controlled distribution. |
| X14 | Recovery keys/phrases | No recovery-code enrollment/use found in the inspected auth configuration. Add single-use recovery codes with correct assurance boundaries. |
| X15 | AI-assisted data mapping | CSV import exists; add reviewed mapping proposals and governed resumable migration. Fix current import authorization/currency path first. |
| X16 | Tailscale-like private connectivity | Useful optional transport, never permission to expose production to a development agent. |
| X17 | Files and model modalities | OCR exists separately; general chat adapter uses text content. Add typed attachments and modality-aware routing. |
| X18 | Neon and Supabase | Good optional PostgreSQL deployment targets; validate compatibility without bypassing Chaste's kernel or adopting a second auth authority. |
| X19 | Website intake and employee lifecycle | Public support/portal endpoints and recruitment primitives exist; add scoped public intake and lifecycle orchestration. |
| X20 | Documents and cross-module automation | Useful foundation, insufficient for broad enterprise document automation; prioritize immutable versions, provenance, review and safe derivations. |

## X01 — Accountable identity from request to effect

**Evidence.** `apps/web/src/server/kernel.ts`, `actorFromResolved`, sets `actor.id = resolved.userId` and type to `agent` or `human`; chat calls it with `asAgent: true`. `packages/kernel/src/ledger.ts` records actor type/ID. This can distinguish “Alice acting through chat's agent” from “Alice acting through the human adapter.” It does not establish which physical person operated a session, and agent type alone does not identify a stable agent instance. Worker actors and approval re-execution need richer provenance.

**Decision.** Extend B01/B02/A01 with server-derived `initiatedByUserId`, `executedByPrincipalId`, `principalType`, `agentInstanceId`, `runId`, `delegationId`, parent delegation, trigger type, `approvedByUserIds`, policy revision and effect receipt. Preserve the initiating agent when a human approves execution; never overwrite the history with just the approver. A named agent belongs to a user/team mandate but is not itself a user credential. Scheduled organizational work has a service identity and an accountable owner; do not falsely attribute it to the last person who edited a routine.

Show “Alice's purchasing agent prepared this; Bob approved; Purchasing Worker executed” with links to the authorized run/approval. Audit views can filter by person, agent, system and delegation. All attribution fields come from authenticated context, never model/tool input. API callers get distinct principals and delegated scopes. On revocation, no new effects execute; history retains deactivated-principal tombstones under retention policy.

**Owner/priority/gate.** Kernel + IAM; P0/W1–W2. One fixture covers direct human, personal agent, team routine, external API, human approval, retry and revoked owner. Each receipt has the complete causation chain, including retries and compensation; spoofed actor fields are rejected. Inspect existing ledger projections before promising this wording is already available.

## X02 — Operational skills are maintained product knowledge

**Evidence.** `modules/skills/src/index.ts` has static advisory playbooks, `skills.find` keyword summaries and `skills.load` steps/capability IDs. Access uses `documents.read`. No tenant-versioned skill lifecycle or capability availability filtering inside these tools was found. Some advice is stale or misleading: reorder notes say lead times are not modeled despite the delivered reorder work; month-end guidance conflates unpaid bills with unposted items; payroll wording says execution pays real money without distinguishing ledger posting from external settlement. “Improvise” must never imply waiving a policy or missing invariant.

**Decision.** Retain progressive discovery. Give each skill a stable ID/version, owner, reviewed date, supported capability/schema ranges, required module set, applicable entity/jurisdiction/product types, intended outcomes, exceptions, evidence references, examples and regression fixtures. Validate capability references against the composed registry and flag stale descriptions during releases. Separate global maintained skills, reviewed tenant SOP overlays and untrusted imported skill text. Skill loading cannot grant permissions, install tools, run shell commands or expand a mandate. Effective discovery respects tenant modules and principal scope; show a safe “requires access/setup” state where appropriate without revealing restricted metadata.

Use a browser/server-safe skill schema and dedicated permissions where tenant SOPs are sensitive. Skill updates need preview/version history, review, opt-in activation where behavior materially changes and rollback. Record which version guided a run. Track completion/error outcomes locally; privacy-preserving aggregates may inform maintainers. Test retrieval across synonyms and languages rather than replacing deterministic policy with a larger prompt.

**Owner/priority/gate.** Domain enablement + runtime; P1/W2–W3, stale financial guidance P0 correction. Domain experts approve revised procure/pay, stock reorder, close and payroll playbooks. Conformance rejects missing IDs/version incompatibility; disabled modules are not recommended as executable; an injected tenant SOP cannot bypass approval. Preserve distinctions among advice, policy and executable workflow.

## X03 — A development skill pack for coding agents

**Evidence.** Committed `.agents/skills/` contains Next runtime/cache/prefetch guidance; root AGENTS provides kernel/domain conventions. Creator scaffolding generates source and test skeletons. This does not constitute a complete module-development skill or executed verification pack.

**Decision.** Plan repository-owned skills for (1) capability/module development, (2) exact domain math and migrations, (3) human/agent surfaces and receipts, (4) integration/tenant security testing, and (5) release evidence. Use one shared module contract template with focused references rather than copy-pasting architecture into five prompts. The development entry skill reads relevant ADRs, declares scope and unlazy gates, then produces schemas, pure domain functions, governed capabilities, transaction-aware repositories, event/compensation declarations, registration, human UI/API, operational skill updates, documentation and tests.

Require paired human/agent proof and module-enabled/disabled cases; bootstrap, imports and public intake require explicit trust-boundary treatment. Money math gets range/property tests; significant decisions get proposed ADRs; dependencies regenerate the lockfile; UI edits use `next-dev-loop`. Include one complete reference module with a real failing-before/passing-after regression, not a placeholder assertion. Version and pin the pack in each evolution run.

The pack helps an author; it cannot certify its own output. Mandatory verifier rules remain outside candidate write authority as defined in E02. Skills must not tell agents to execute instructions encountered in documents or test output. Add/update these skills during implementation using the skill-creator workflow; this planning task does not install or modify them.

**Owner/priority/gate.** Developer platform + architecture; P1/W2 and W5. A coding agent builds a small service-delivery capability from the pack; independent CI proves tenant isolation, permissions, idempotency, discovery, human surface and domain postconditions. A missing registration or fake test result blocks completion.

## X04 — Capability discovery is part of release, not just source generation

**Evidence.** `packages/kernel/src/registry.ts` registers and validates capabilities and exposes `forActor`, `scopedToModules` and keyword `search`. The loop builds tool specifications from the actor-visible registry. `apps/web/src/server/kernel.ts` explicitly imports/registers modules and caches the registry using `REGISTRY_VERSION`. A new source file or marketplace listing alone is not executable/discoverable production functionality.

**Decision.** Release pipeline: capability contract → conformance/tests → registration manifest → immutable registry digest → reviewed deployment → tenant enablement/permissions → discovery refresh. Generate a read-only capability catalogue from the actual registry, including aliases, examples, resource/result types, input requirements, module dependencies, risk and version. Add governed `capabilities.search`/`describe` tools for progressive discovery; never mount every tenant's full catalogue into a session. Search ranking may be semantic, but results must come from authorized registered capabilities. A vague command first searches existing capabilities/workflows before filing a gap.

Deploy registry and discovery index atomically by digest; run health checks on every worker replica. An old run keeps pinned semantics until a safe checkpoint: show newly available capability and require replan/authorization if behavior changes. Tenant enablement never auto-grants permission; a skill load never activates a plugin. Provide developer diagnostics explaining “registered but module disabled,” “permission denied,” “index stale,” and “missing UI route” without exposing these internals unnecessarily to business users.

**Owner/priority/gate.** Kernel + release; P1/W2–W3. Add a test capability, deploy, search by a user synonym and execute via authorized agent; deny disabled/unauthorized access. Test rolling deploy, stale index, removed capability and capability version conflict. Human and agent availability match the same registry.

## X05 — Automation rules and durable workflows

**Evidence.** Routines, recurring invoice jobs, signals and module-specific state transitions exist. A generic visual rule designer with persisted branching/waiting contracts is not established. Odoo's documented automation rules combine triggers, optional conditions and one or more actions; that is a useful usability reference, not a claim of Chaste parity. [Odoo automation rules](https://www.odoo.com/documentation/19.0/applications/studio/automated_actions.html)

**Decision.** Build three clear layers on B03/B04: deterministic rules (event/time → condition → capability), durable workflows (steps, branches, waits, approval, timeout, compensation), and bounded agent steps for ambiguous classification/planning. Routine prompts remain one trigger source. An AI assistant can draft a rule from “when a supplier bill arrives, match it and ask me about discrepancies,” but the user previews a typed definition and simulation before activation. A rules engine does not require a model to evaluate “invoice overdue by 14 days.”

Version definitions with owner, scope, trigger schema, previous/new values, time zone, conditions, step IDs, retries, deadline, error handler and resource budget. Use an allowlisted expression AST, never user-provided JavaScript/SQL/eval. Map actions to capabilities. Support business-day calendars, pause/resume, run history, test-on-sample, dry run and controlled backfill. Start with templates before a free-form canvas. Distinguish pausing a definition from cancelling in-flight instances.

Prevent event recursion with causation-chain depth, per-record occurrence identity, watched-field transitions, cooldown and bounded fan-out. Deterministic wait state is not a sleeping web request. Definition changes affect new runs unless existing instances are explicitly migrated. Agent steps inherit the workflow principal's mandate; “automation” does not bypass human approvals.

**Owner/priority/gate.** Runtime + product; P1/W3 after B02/B03, sophisticated designer P2. Prove overdue reminder, bill mismatch approval and new-hire checklist using templates; simulate update-trigger loops, DST, duplicate webhooks, approval waits, crash recovery, definition edits and revocation. Show current step, blockers and next owner in UI.

## X06 — Goods, services and mixed transactions

**Evidence.** `packages/db/src/schema/index.ts`, `items`, stores SKU, unit, price and reorder point but no product/service kind. A custom unit label does not establish service semantics. Free-text invoice lines are also not a full service lifecycle.

**Decision.** Introduce catalogue `productKind` (`good`, `service`, and later `digital` if demanded), with independent constrained policies for inventory tracking, fulfillment and billing. Separate tracked physical goods, untracked consumables and services; bundles reference component definitions. Subscription is a billing arrangement, not proof that a product is intangible. Avoid a single boolean whose meaning spreads inconsistently across modules.

| Behavior | Physical good | Service |
|---|---|---|
| Fulfillment | Shipment/receipt, optional lot/serial tracking | Appointment, timesheet, milestone or service acceptance |
| Availability | Stock/ATP and reservations if tracked | People/equipment capacity or contracted availability where supported |
| Purchasing match | Ordered/received/invoiced quantities | Ordered/accepted effort or milestones/invoiced amount |
| Billing basis | Ordered or delivered quantity by policy | Fixed fee, accepted milestone, approved time or recurring period |
| Cost/reversal | Inventory valuation/COGS and physical return | Labor/subcontract cost and credit/correction; no stock return |

Snapshot kind, fulfillment/billing policy, unit, tax category and price terms on transactional lines. Mixed orders may ship goods and accept services separately; invoice only eligible lines, preserving shared payment/credit controls. Service revenue recognition and local tax rules need finance-reviewed policy, not automatic recognition at delivery inferred by an LLM. Goods delivered electronically and physical rentals require explicit policy, not a shortcut based on tangibility alone.

Migration: rows with stock history retain physical semantics; ambiguous rows enter a review queue. Do not bulk-label historical items “service” based on names. Prohibit kind changes that invalidate posted history; create a new effective version or a replacement catalogue item. Service-only businesses can disable inventory and still quote, deliver, invoice, purchase and report.

**Owner/priority/gate.** ERP core + sales/purchasing/inventory/HR; P0 contract/W1, P1 implementation/W3. Prove consulting-only, mixed installation-plus-equipment, untracked consumable and partial milestone scenarios. Services never create stock movements; goods preserve existing valuation/inverse invariants; migrations preserve historical documents and report totals.

## X07 — Structured questions: retain and harden the existing feature

**Evidence.** `packages/kernel/src/loop.ts` defines `AskQuestion`, exposes `ask_user`, emits `ask` events and ends the turn. Chat streams them and `apps/web/src/app/(app)/chat-ui.tsx` renders `AskCard` with choices/free text. This is already the requested tool-plus-component pattern; a second implementation would create drift. In the loop, the turn ends after processing the tool-call batch, so a question does not itself prove subsequent calls in that same batch are suspended.

**Decision.** Persist questions as run-bound objects with ID, contract revision, field/resource context, supported control type, safe options, optional recommended answer, requiredness and expiry. Answers are authenticated, schema-validated, idempotent and bound to the question revision. Never interpret a selected default or elapsed timeout as consent. Mark answered/cancelled/expired/superseded questions in replay. Reconnect and another device can resume the same question; headless workflows wait/escalate to their owner.

Use narrow UI schemas for single/multi-choice, date, amount/currency and authorized record picker, not arbitrary model-generated HTML. Ask only when ambiguity changes action, authority or irreversible consequence. The renderer provides a keyboard-accessible free-text alternative where sensible. Treat every unresolved required answer as a dependency barrier; prohibit related tool calls even if emitted in the same model batch. Independent reads may continue only when explicitly safe.

**Owner/priority/gate.** Runtime + chat UX; P0 batching review, P1/W2 durability. Test question followed by a write in the same response, double answer, outdated answer after replan, tenant switch, expired session and free-text validation. No dependent effect occurs until a valid answer; the UI does not lose an answer on refresh.

## X08 — Action receipts and direct navigation

**Evidence.** Tool results return entity IDs in many modules; there is no universal resource-link envelope in the inspected executor/loop. General session links exist, but they are not a guaranteed link to a newly created customer. A dedicated customer detail route was not found in the app route inventory.

**Decision.** Extend success/pending receipts with typed resource references, e.g. `{type: "customer", id, relation: "created", label}` plus action/run/approval IDs. The server's route registry resolves links; models cannot invent URLs, embed arbitrary external schemes or claim a guessed record exists. Build canonical tenant-aware detail routes (or a durable list/detail-panel deep link) for customer, supplier, order, invoice, application, document and report first. URL selection alone never conveys authorization; resolve tenant membership and resource scope on navigation and return safe inaccessible/archived states.

Show “Customer created — Open customer” from the committed receipt. Multi-action responses show the primary result and an expandable list of related receipts. Pending approval links to the proposal, not an entity falsely described as created. Stale/deleted records show retained history where authorized. Undo links invoke governed compensation and explain eligibility. Clipboard/open-new-tab and browser back behavior should work without a chat session remaining open.

**Owner/priority/gate.** Kernel contracts + product UI; P1/W2–W3. Create a customer in chat, click the receipt, land on the exact authorized record, then verify tenant switch, revoked access, delayed commit, duplicate retry and archived record. Every advertised action link comes from a real persisted resource or proposal.

## X09 — AI enabled by default, with graceful granular controls

**Evidence.** `/api/ai-config` is read-only environment configuration; module availability and some routine/support settings exist. No unified feature-level policy for all AI calls was established.

**Decision.** Default on for permitted assistive features: chat explanations, draft suggestions, mapping suggestions and document extraction when a configured approved provider is available. This does not default on L3 execution, new external data sharing or diagnostic uploads. Respect organization restrictions, user preference and provider/data-class eligibility; a user may disable assistance but cannot re-enable an organization-prohibited feature. Explicitly reconcile with A01: L1 default remains; L2/L3 require their existing authority gates.

Feature catalogue: conversation, inline suggestions, proactive summaries, AI document extraction, mapping recommendations, analytics narrative, support drafting, operational agent execution and development suggestions. Each has scope/default, data destinations, dependencies, reason disabled and manual fallback. Separate personal presentation preferences from organizational execution policy. Turning off chat rendering alone must not pretend it cancelled a background run.

On disable: stop admitting new affected calls, cancel safe in-flight generation, preserve saved drafts and receipts, resolve queued work to paused/manual-review, and report unavoidable already-sent external effects. Deterministic workflows, reporting and manual ERP operations remain available. Retain past audit evidence; switching off AI does not delete business history or disable security controls. Re-enable from an explicit checkpoint rather than replaying all missed external actions.

**Owner/priority/gate.** Product + policy/runtime; P1/W2–W3. Turn each feature off before request, during stream and while queued; verify server/worker enforcement across replicas, no further provider egress, accurate partial outcomes and a usable manual path. Test workspace settings versus user overrides and a provider outage.

## X10 — Product telemetry and voluntary diagnostics are different channels

**Evidence.** `/api/metrics` aggregates tenant session token/cache usage; structured logs and audit events exist. This is not proof of safe product-wide telemetry, consent, screenshot capture or bug-report handling.

**Decision.** Use an allowlisted, versioned event schema: feature code, app version, coarse environment class, outcome/error code, bucketed duration/count and coarse workflow stage. Do not collect prompts, outputs, record names/IDs, email, invoice values, full URLs/query strings, filenames, free text, DOM contents or persistent user/device identifiers in automatic product analytics. Strip transport metadata such as IP and user-agent detail before retention; disable infrastructure access logs that would undermine this claim. If cohort identifiers become necessary, classify them as pseudonymous rather than claiming anonymity, document purpose/retention and obtain the appropriate choice/review.

Aggregate on the client/tenant edge where practical, suppress small cohorts and rare combinations, bound retention, and audit the full egress path. Error reporting uses normalized codes and build/source-map references; scrub raw exception messages, arguments, headers, breadcrumbs and stack paths. Test with planted private values across every event field. Prefer minimal reliability counters on with disclosure and an organizational opt-out subject to service-operation obligations; optional product research is a separate setting. AI defaults do not imply telemetry consent.

A “Report a problem” flow is voluntary: describe issue, preview exactly what will be sent, optionally attach a screenshot, crop/redact, confirm submission, receive a ticket/status link. Screenshot/description can contain PII, so they cannot truthfully belong to a “no PII ever” automatic telemetry channel. No background screenshots or session replay. Offer a text-free sanitized diagnostic bundle and a local download alternative. Scrubbing is best effort; minimize, encrypt, restrict support access, expire attachments and provide deletion controls under policy. Never send support attachments to development/model providers automatically; approved sanitized fixtures cross E03 separately.

**Owner/priority/gate.** Privacy/security + product reliability; P1/W3. Network-capture tests under all preference states show only allowlisted fields; canary PII does not leave via automatic telemetry, logs or proxy metadata. Manual screenshot upload requires preview/confirmation, access controls and deletion verification. Track actual product outcomes, not user surveillance.

## X11 — Missing capability becomes a useful next step

**Evidence.** Chat supplies `TicketSink.file`; it inserts a ticket but returns no ID. The loop returns `{ok: true, note: "ticket filed"}`. This does not give a usable ticket receipt, status, workaround or delivery commitment.

**Decision.** Classify unavailable action: needs clarification, missing permission, disabled module/AI, incomplete setup, unsupported connector, temporary failure or genuinely absent capability. Search authorized capabilities/workflows first. Do not file a development feature gap for an access denial or provider outage. Return an actionable card: what was understood, what could/could not be completed, preserved draft, safe next action and responsible owner. Offer enable/setup/request-access links where allowed, a manual alternative, or a tracked feature request.

Persist gap ID, source contract/run, impact, acceptance condition, duplicate linkage, visibility and triage state; return the actual reference. Let the user follow, add context, cancel or assign it. Propose “prepare the draft now” only when the existing capabilities can safely do so. No fictional workaround, delivery date or “we're building it” claim without an accepted development run. Feedback sharing outside the tenant follows X10. Once a verified feature ships, notify subscribed users and offer to resume/replan with fresh authority; never silently execute an old request.

**Owner/priority/gate.** Runtime + support/creator + UX; P1/W2–W3. Unsupported command yields a persistent link and next action; retry deduplicates; permission denial does not create a misleading feature request; partial completed work is accurately listed; ticket-storage failure is never reported as success.

## X12 — Analytics as an evidence-backed exploration workspace

**Evidence.** `modules/analytics/src/index.ts` provides typed extractors, frame operations, `explainChange` and `askYourBusiness`; source permissions gate extractors. This is a useful basis. A full metric semantic catalogue, provenance-bound dataset handles and saved investigative workspace were not established.

**Decision.** Organize analytics around “What changed?”, “Why?”, “What needs attention?” and “What could happen?” Offer role-specific starter views, saved explorations, filters and conversation over the same authorized datasets. Every metric has owner/version, definition, unit/currency, time basis, exclusions, grain, aggregation rule and supported dimensions. Distinguish revenue, invoiced amount and cash collected; distinguish zero, missing data and disabled source modules.

Chart → contributing rows → source record → receipt must preserve filters/as-of time. Show freshness, coverage and whether data is actual, forecast or scenario. Attribute arithmetic decomposition exactly; do not label correlation as cause. Scenarios show explicit assumptions and never mutate source transactions. Suggested action opens a governed draft. Users can do all standard filtering/drill-down without AI; AI narratives cite dataset/metric versions and cannot invent missing rows.

Add comparable-period selection, useful segmented trends, anomaly investigation and saved views before a general drag-and-drop BI engine. Enforce row/field-level permissions through aggregates and drilldowns, suppressing sensitive small groups where needed (particularly HR). Bound query cost/cardinality and paginate details; large exports run asynchronously. Financial totals use exact arithmetic even if charts use display approximations.

**Owner/priority/gate.** Analytics + domain/UX; P1/W3. Trace a revenue change to exact rows; reconcile totals with standard accounting reports; test timezone boundaries, returns, cash/accrual basis, mixed currencies, hidden records, stale projections and AI-off operation. Usability research checks that users can explain the metric and find evidence, not just like the chart.

## X13 — Reports as durable business artifacts

**Evidence.** `analytics.renderReport` accepts caller-provided rows/operations/narrative and emits HTML/SVG; `report.ts` provides printable HTML. It formats what it receives. It does not prove the supplied rows came unchanged from a trusted extractor; a model-generated table can look authoritative without verified provenance. Standard accounting/report endpoints also exist.

**Decision.** Separate exploratory analysis from official report definitions and issued report runs. Use versioned templates with parameters, metric/dataset handles, authorized audience, as-of cutoff, entity/currency/basis, reconciliation checks and presentation specification. Authoritative reports resolve server-issued dataset references/digests; arbitrary caller rows are labelled user-supplied/unverified and cannot receive a “verified ERP report” badge. Narrative is optional, visibly separate from computed facts and evidence-linked.

Persist an immutable report snapshot plus definition/source revisions, creator/agent/approver chain, generation timestamp, actual data cutoff, integrity digest and artifact links. Offer accessible HTML, CSV/XLSX for analysis and verified PDF where demanded; preserve exact money and units and neutralize spreadsheet formula injection. Editing a template does not rewrite issued history. Add report centre with templates, favorites, schedules, run status, retries, comparisons and an index by reporting period.

Scheduled delivery uses the outbox and rechecks recipient authorization at generation and delivery; revocable authenticated download links are preferred over permanent public URLs. Password/secret material never appears in reports. Large reports have row/page limits and truthful truncation; failures retain parameters and do not email half-generated artifacts. Accessibility includes tabular alternatives and clear printed headers, page breaks and negative/currency formatting.

**Owner/priority/gate.** Analytics + finance + documents; P1/W3–W4. Repeat an issued report from pinned sources; reconcile to GL; reject fabricated dataset provenance; revoke recipient before delivery; render large/multi-page and RTL/locale fixtures; verify safe spreadsheet export. AI-off gives the same numeric report.

## X14 — Account recovery without a universal master phrase

**Evidence.** `apps/web/src/server/auth.ts` configures email/password sessions and throttling; no app-level backup-code or passkey recovery enrollment is present in the inspected configuration. Library availability does not mean the product flow is wired.

**Decision.** Add recovery-code enrollment alongside strong authentication, preferably multiple passkeys/security keys and suitable MFA. Use the auth provider's vetted mechanisms where available after checking the installed version; do not invent a new cryptographic login protocol. Generate high-entropy random single-use codes, show once, support download/print, store only appropriate verifiers, redact all logs and never expose them to an agent. Regenerating invalidates the prior set; consuming a code is atomic and rate-limited.

Define assurance precisely: a backup code typically replaces a lost second factor; it need not bypass the primary credential, an enterprise IdP or a disabled account. If supporting complete account recovery, define a separate verified recovery process with limited recovery session, notification to existing channels, suspicious-event controls and session/token revocation. Enforce tenant SSO policy and deprovisioning; possession of an old recovery code cannot reactivate a former employee. Protect last-owner recovery with documented checks and audited support handling, not security questions.

Recovery of login is different from recovery of encrypted customer data. Do not advertise a seed phrase that unlocks every tenant or a database encryption key. If customer-held encryption keys are later supported, design escrow/loss behavior separately and explain irreversible consequences. Recovery secrets must never be pasted into chat or collected in screenshots/telemetry.

**Owner/priority/gate.** IAM + security; P1/W3, before enterprise identity readiness. Test single-use concurrency, rate limiting, regenerate/reuse, lost device, compromised email, SSO-only account, disabled employee and last administrator. Recovery cannot elevate role or bypass audit/step-up for sensitive operations.

## X15 — AI-assisted mapping with deterministic migration controls

**Evidence.** `/api/import` handles customers/products with row validation and batched direct inserts. It checks authentication/org but no explicit domain permission before those writes. Its `toMinor` uses `Number` and `Math.round(n * 100)` despite a “no float” comment, assuming two-decimal currency. These are source-observed governance and exact-currency gaps; do not expand AI import around them.

**Decision.** First move import writes into B01/B02-governed bulk/row capabilities with exact decimal parsing, tenant currency/unit handling, permission checks and receipts. Then add assisted onboarding: inspect headers/sheet names/types and minimal approved samples; suggest mappings, enums, date formats, currency scales, units and relationship keys; explain uncertainty; let the user compare source and normalized previews. Prefer deterministic matches first and use a model for ambiguity, not arithmetic. Header-only/no-egress mapping works when AI or data sharing is disabled.

Version a typed transformation plan (rename, trim, parse, map enum, lookup, dedupe) with no arbitrary executable code. Require user resolution of ambiguous dates, mixed currencies, product/service kind, duplicates and conflicting ownership. Process source records in dependency order with stable external IDs. Import opening balances, attachments and relational references only through their specific governed contracts; accountant review governs financial opening state.

Offer sandbox trial migration, mapping reuse, validation summary, dry-run totals, partial batch receipts, safe resume and a correction file. Never hide dropped rows or silently coerce invalid price to zero. The final reconciliation includes source/accepted/rejected/duplicate counts and monetary totals, relationship orphans and first-posting readiness. Apply provider data policy and retention to all samples; private mapping content is not product telemetry.

**Owner/priority/gate.** Integrations + ERP core/security + onboarding UX; P0 existing boundary fixes/W1, P1 assistant/W3. Restricted user cannot import; 0/2/3-decimal currencies and locale decimals remain exact; ambiguous dates require review; repeating a file/intent does not duplicate; mixed service/goods and foreign-key dependencies reconcile; model failure leaves manual mapping usable.

## X16 — Private prod/dev communication

**Decision.** Yes, consider Tailscale or a comparable WireGuard-based private network for operations endpoints and a narrow artifact-exchange service. Tailscale supports workload identity federation using provider OIDC identity, which can reduce standing join credentials. Product choice remains conditional on deployment support, region, controls and operating cost. [Tailscale workload identity federation](https://tailscale.com/docs/features/workload-identity-federation)

Preserve E03: production emits sanitized gap artifacts; development reads only the exchange. Dev/build runners never receive general production database, shell or subnet access just because they joined a private network. Use deny-by-default grants for service identity, destination and port, separate production/development identities and tightly scoped ephemeral runner membership. Prefer private connectivity for trusted orchestration; an untrusted candidate runner has no production-network membership. Artifact/API authorization, signed envelopes, short-lived application credentials, replay protection and tenant scope remain mandatory above the transport.

Avoid broad subnet routes, an all-to-all tailnet and shared node keys. Human emergency administration is a separate audited, time-bound path. Keep public intake endpoints public through their purpose-built boundary, not through exposed private admin services. Provide ordinary TLS/OIDC or mTLS transport behind the same exchange interface where a mesh client is unavailable; no mandatory VPN dependency for every customer installation.

**Owner/priority/gate.** Platform/security; P1/W5 optional deployment profile. Network tests prove candidate runner cannot reach production DB/admin ports or other tenants, including compromised runner identity; revoke identity mid-run; test control-plane/network outage and queued artifact recovery. Joining the network cannot approve a release or authorize an ERP capability.

## X17 — Attachments and modality-aware models

**Evidence.** Kernel `LoopMessage.content` is a string and `OpenAiCompatAdapter` maps that into chat content; the normal chat path is not a general attachment pipeline. `packages/ai/src/documents.ts` separately sends bytes as an `image_url` to an OCR model. Generic MIME syntax and an OCR call are not proof that PDF, Office, audio or video files are supported.

**Decision.** Introduce typed text/image/file/audio/video content references in a provider-neutral message envelope. Attachments are authorized immutable object versions, not arbitrary URLs from the model. A capability catalogue for each actual provider/model/API version declares accepted MIME types/modalities, tool-use/structured-output compatibility, limits, context budget, region/privacy constraints and fallback routes. Probe/test provider support, record the effective model/version and never infer capabilities from “OpenAI-compatible” or a model family name.

Routing: validate file → choose deterministic parser where possible → approved OCR/vision/transcription when required → create cited derived observations → pass suitable parts to the selected reasoning model. If a text-only model receives an image, use an allowed vision/OCR helper and clearly identify the derived description, or ask the user to choose an eligible model/provide text. Never silently discard the attachment or say the text model saw it. OCR is suitable for text extraction; it does not reliably replace visual understanding of a chart, damaged goods or layout. A multimodal model can receive native parts where approved; it still must not authorize extracted instructions.

| File family | Initial handling contract |
|---|---|
| TXT/CSV/JSON | Bounded deterministic parser, encoding/schema validation; no formula/code execution. |
| XLSX/ODS | Sheet/table extraction and mapping, preserve exact values/formulas as data; sandbox parser, reject macros/external links. |
| PDF/DOCX | Text/layout extraction; scanned-page OCR; page references, truncation and encrypted-file handling explicit. |
| Images | Sniff bytes, strip unneeded metadata, limit dimensions/decompression, OCR or native vision with provenance. |
| Audio/video | Explicitly supported transcription/frame sampling adapters with timestamps, costs and missing coverage; otherwise honest unsupported response. |
| Archives/executables | Reject by default; any future archive support uses isolated expansion and strict count/size/ratio limits. |

DeepSeek is a valid candidate to evaluate: current official docs identify V4.1 Flash behind API name `deepseek-flash` and document image input. Older aliases may be remapped, so an alias is not a reproducibility guarantee. These sources support eligibility for adapter/eval work, not an assertion that it is the best model for every ERP task or supports every modality. [DeepSeek API naming](https://api-docs.deepseek.com/), [DeepSeek vision](https://api-docs.deepseek.com/guides/vision/)

**Owner/priority/gate.** AI platform + documents/security; P1/W3. Matrix tests text-only, image-capable and unavailable provider routes; mixed attachments, long/scanned/password-protected files, corrupt MIME, oversized image, provider failover and egress opt-out. Citations point to source versions/pages and truncation is visible. Failover preserves privacy and required modality.

## X18 — Neon and Supabase as optional PostgreSQL targets

**Decision.** Yes, support both through a tested database deployment profile while retaining ordinary PostgreSQL/self-hosting as the baseline. Neon documents pooled PostgreSQL connectivity; Supabase provides PostgreSQL connection options. Validate Chaste against each exact deployment configuration rather than marking support complete because a connection succeeds. [Neon pooling](https://neon.com/docs/connect/connection-pooling), [Supabase PostgreSQL connections](https://supabase.com/docs/guides/database/connecting-to-postgres)

Keep Drizzle/repositories and the kernel as business authority. Do not expose ERP writes through a generated database REST API or move application identity to Supabase Auth as an incidental hosting change. Runtime uses a custom non-owner/non-bypass role; migration/administration credentials are separate. Supabase service-role credentials bypass RLS and are not appropriate general runtime authorization for Chaste. Review exposed schemas/grants and revoke unintended browser access. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

Profile checks: PostgreSQL version; pgvector/pgcrypto/pg_trgm and required migrations; grants/trigger privileges; transaction-local tenant settings; transaction advisory locks and isolation; prepared-statement behavior; pooled/direct connection use; TLS; connection ceilings; cold-start/reconnect; worker leases; backup/restore and region requirements. Use direct/admin migration connectivity where necessary. Do not rely on session-affine `LISTEN/NOTIFY` over transaction pooling; retain durable polling or a dedicated appropriate connection. Managed branches for testing use synthetic data, never an unapproved production clone.

Supabase Storage/Realtime and Neon branching may be optional adapters if they solve a measured need. Their storage/read policies must match document/resource permissions, and broadcasts must not leak tenant data. An HTTP/serverless database driver is not a drop-in replacement unless it preserves the multi-statement transactional/locking semantics B02/B03 require.

**Owner/priority/gate.** DB/platform; P1 compatibility investigation/W0, supported profiles W3. Run the same migrated non-owner RLS, money, queue crash/idempotency, approval and restore suites on local PostgreSQL and both managed targets. Publish supported profile versions and limits. No hosted provider account or production migration is created by this plan.

## X19 — Public intake APIs and employee lifecycle

**Evidence.** `/api/support/public`, tokenized invoice portal and routine webhook routes exist. HR has opening/applicant/stage/hire capabilities, employee structure, time/leave and payroll primitives. A public careers submission API and complete employee lifecycle were not found. Public support uses a per-org embed token plus conversation ID for reads in the inspected route; an embed token shipped to browsers is public identification, not proof of visitor identity. Submitted email is also not identity verification. Review this before extending the pattern to sensitive intake or order information.

**Decision.** Add versioned public intake definitions with published form schema, field allowlist, tenant/public-form identifier, destination opening, expiry, limits, consent text/version and attachment rules. Public submission can create only a constrained intake record through a scoped capability; it cannot choose actor permissions, employee state, arbitrary tenant ID or hidden HR fields. A publishable form ID is not a secret. Validate opening eligibility and resolve tenant on the server. Add bot/spam controls, rate/size limits, file quarantine, idempotent submission, private receipt and abuse monitoring. CORS is usability configuration, not authorization.

Support website-hosted forms and a server-to-server API with separately scoped credentials and signed webhook acknowledgements. Publish OpenAPI/examples for fields, errors, retry keys, attachment upload and status polling. Applicant follow-up uses per-submission proof or verified login, never another applicant's guessable identifier. Fix public support with a conversation-specific high-entropy visitor credential and verified customer binding before exposing sensitive account/order data.

Lifecycle: requisition/approval → published opening → application/consent → screening/human review → interview → offer/acceptance → hire → employee onboarding/tasks/access → probation/development/leave/payroll → transfer/change → offboarding/access removal/assets/final settlement → retained/archive record. Build missing portions incrementally; share documents, workflow, IAM and projects rather than duplicate them inside HR. Hire conversion is idempotent and preserves applicant-to-employee lineage with tighter employee access. AI may summarize job-relevant evidence with source links; do not enable autonomous rejection/hiring or sensitive-trait inference. Record human decisions and a correction path.

**Owner/priority/gate.** Integrations + HR/IAM/security; P0 public-boundary review, P1 careers intake/W3, deeper lifecycle P2. Submit from an external site, quarantine CV, create one applicant, acknowledge privately, hire once and trigger governed onboarding. Prove cross-tenant, mass-assignment, attachment, duplicate, closed-opening, withdrawal, access revocation and public-support isolation cases.

## X20 — Documents as a governed evidence system

**Judgment.** Keep the module, but it is not yet sufficient for the enterprise document and automation ambition. `modules/documents/src/index.ts` handles uploads/text, OCR, coding suggestions, memory, metadata and versions. Important source findings: primary bytes live as base64 in database rows; memory includes only the first 8,000 characters; line extraction in `packages/ai/src/documents.ts` uses only 12,000 characters and “cents” wording; parsing embeds inside a transaction; `addVersion` replaces content without resetting parsed content/status or invalidating memory/suggestions in that path; delete does not explicitly clear the string-linked memory records. Verify database cleanup triggers separately before asserting an orphan exploit. Concurrent version allocation and parse-versus-update also need tests.

**Decision.** Use immutable document versions with content hash, detected format, size, object storage reference, owner/resource ACL, source/channel, sensitivity, retention/legal hold and classification. Keep small text inline if justified; put substantial binaries in private object storage behind an interface. Add authorized preview/download and short-lived upload links, quarantine/scanning, parser isolation and full lifecycle states: uploaded → scanned → classified → extracted → review_needed → accepted → linked/processed → archived. Each derivation identifies exact source version, parser/model/schema revision, page/span/cell references and confidence/validation findings. A new version makes prior derivations visibly stale; never attach old OCR to new bytes.

Chunk full supported content with page/section provenance, dedupe by version/chunk, enforce document ACL at retrieval and remove/restrict derived memory on permitted deletion or access changes. Retention preserves evidence needed by posted documents; “undo upload” cannot destroy a referenced financial source. Legal hold overrides ordinary deletion. An immutable old version remains usable for historical evidence without being mistaken for the latest document. Compare-and-swap version checks prevent a late parser overwriting the current result; move all provider IO outside DB transactions.

Extraction creates reviewable business drafts, never direct postings from untrusted text. Document automation uses X05: supplier invoice → duplicate detection → vendor/PO/receipt matching → totals/tax/currency validation → bill draft → approval; service invoice uses acceptance evidence instead of fake stock receipt. CV → applicant draft; signed contract → obligation/renewal task; delivery note → receipt proposal; expense receipt → claim draft. Deterministic validation and current policy decide whether a specific low-risk workflow can advance automatically; raw model confidence cannot authorize payment.

UI: document inbox with batch triage, split/merge page controls where supported, source preview beside extracted fields, highlighted evidence, correction history, related records, workflow progress and actionable failures. Handle duplicate uploads, missing pages, multiple invoices in one file, conflicting totals, password-protected files, versions arriving during review and unsupported languages. Re-extraction must not duplicate bills, applications or receipts; links/derivations have idempotent identity and downstream effects retain source snapshots.

**Owner/priority/gate.** Documents + integrations/domain/security; P0 stale derivation/retention review, P1/W3 pipeline. Revise a parsed document during extraction; old job cannot publish current results. Test delete/revoke against search, retention-held invoice evidence, full-document/page coverage, duplicate invoice across uploads and two-document-version concurrency. User can correct one field, see why a draft exists, approve it and navigate from receipt back to the exact source page.

## Delivery integration and proof requirements

This addendum extends, rather than replaces, W0–W7 in the parent plan. No new feature overrides the existing authority, exact-money, privacy or isolation gates.

| Wave | Addendum work | Required integration proof |
|---|---|---|
| W0 | Inventory X01/X04; reproduce import/public boundary and document stale-state findings; compatibility/model checks. | Actual findings tagged confirmed/ruled-out/open; fresh baseline tests, no unsupported capability claims. |
| W1 | X01 attribution contract, X06 goods/service schema contract, X15 import authority/exact amounts, X19 public identity review, X20 stale/retention guard. | Human/agent/import/public paths preserve tenant and domain authority; no old derivation presented as current. |
| W2 | X02 skill corrections, X03 development pack, X04 catalogue, X07 durable questions, X08 receipts, X09 controls, X11 gap handling. | Agent discovers correct capability, asks when needed, executes once, exposes exact record and gracefully handles absence/off state. |
| W3 | X05 workflow templates, X06 service behavior, X10 privacy/diagnostics, X12/X13 analytics/reporting, X14 recovery, X15 mapping, X17/X20 files, X18 tested profiles, X19 intake. | Role-specific end-to-end user flows with AI on/off; permissions and provenance hold through every adapter. |
| W4 | Workflow/analytics scale, controlled report scheduling and modality routing economics. | Queue fairness, precise reports, privacy-preserving metrics and mandate gates under load. |
| W5–W6 | X03 independent verification and X16 optional private exchange; skill/capability rollout updates. | New module passes held-out proof, deploys as exact verified artifact, becomes discoverable, and cannot reach production from untrusted runner. |
| W7 | Deeper HR lifecycle, digital/subscription/capacity models, broader file/connector and workflow designer scope. | Demand and jurisdiction-specific acceptance; no blanket parity claim. |

Three acceptance journeys tie the work together:

1. **Service business:** AI maps customers and service catalogue with ambiguous currency/date resolved through an AskCard; approved import returns exact records; service quote → accepted milestone → invoice produces no stock movement; analytics/report totals reconcile with the accounting view; turn off AI and complete the same deterministic workflow.
2. **External applicant:** public website submits CV with private acknowledgement; scan/extract creates one applicant under restricted authority; human review → hire → onboarding tasks; document/actor lineage is visible; withdrawals and offboarding revoke the appropriate access without erasing required history.
3. **Capability gap to useful release:** agent searches catalogue, explains missing workflow and gives an owned ticket plus safe draft; coding agent uses the module pack; independent runner proves regression and security gates; approved release updates registry/skills; user gets a link to the newly available behavior and chooses to resume under current authority.

Each engineering ticket must carry schema/interface changes, owner, dependencies, migration/compatibility treatment, failure cases, negative controls, observable business postcondition, UI states and rollout/rollback. Use unlazy to verify these outcomes; a generated skill, new API route or pretty report is not sufficient proof by itself.

## Review notes and external verification

Primary references were checked on 2026-09-11 and are linked beside the relevant decisions. Provider names/aliases and hosting behavior must be rechecked against the exact implementation date/version. No provider/network service was provisioned, no external feedback was submitted, and no account recovery or feature flag was enabled by this planning task.

Local review evidence: `.unlazy/enterprise-followup/GATES.md`, with one planning gate per X01–X20. Code searches and the cited implementations support the current-state statements; proposed gates remain implementation work. Runtime verification results for this documentation extension are appended to [ENTERPRISE_PLAN_REVIEW.md](ENTERPRISE_PLAN_REVIEW.md).
