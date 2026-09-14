# Enterprise module audit and everyday product experience

Status: proposed implementation plan; source audit, not a security certification or a claim that fixes have shipped. Reviewed 2026-09-11 against branch `cordis-like-engine`, HEAD `1f3b078`, including the preserved local planning documents.

This extends [Enterprise Evolution](ENTERPRISE_EVOLUTION_PLAN.md) and the [Product Systems Addendum](ENTERPRISE_PRODUCT_SYSTEMS_ADDENDUM.md). Their F01–F17 and X01–X20 remain applicable. N01–N36 below add concrete module findings or materially deepen those investigations. P01–P12 propose product improvements. Existing capabilities, domain functions and useful UI primitives should be strengthened before replacing them.

The product opportunity is to make business work feel continuous: find the right record, understand its current state, take the next valid action, recover from interruptions, and see an accountable result. More autonomous actions are valuable only when those actions preserve business truth and people can understand their effects. Competitive advantage here is a design hypothesis to validate with users; this audit does not establish that competitors lack these features.

The user's clarification applies throughout: **unlazy discipline is for the agents implementing this plan. It is not a completion certificate for this review.** Section 8 specifies their work contracts and evidence requirements.

## 1. Scope, confidence and immediate decisions

**Source-confirmed** means the inspected implementation contains the stated behavior or omission. It does not mean an exploit was performed against a deployment. **Reproduced** means a small local executable check demonstrated the behavior; the exact scope is stated. **Investigation** means the failure scenario needs an integration, concurrency or deployment proof. **Product gap** means a desired workflow is unsupported or too limited; it is not necessarily a bug against the original milestone's scope.

P0 = contain/reproduce and correct before exposing the affected sensitive workflow or increasing autonomy. P1 = next reliability/product delivery wave. P2 = later improvement after adoption evidence. Priorities are conditional on enabled modules and deployment exposure. No CVSS scores, legal compliance claims or production performance measurements are asserted.

Immediate engineering decisions:

1. Treat read authorization as part of the trust boundary. Tenant membership alone must not reveal salaries, private conversation previews, ledger payloads or another module's sensitive signals.
2. Verify identity before binding a login or public support visitor to an existing person/customer record. Keep unverified public inquiries useful with public knowledge and human handoff.
3. Make payment, credit, reversal, stock movement and work-order completion internally consistent before promising autonomous operations.
4. Use accurate outcome language. Recording a campaign send row is not delivery; posting payroll is not proof of bank disbursement; no available signal is not proof that everything is healthy.
5. Preserve drafts and bind asynchronous responses to the record and organization that requested them. This is both a usability and confidentiality requirement.

### Coverage inventory

All 19 current module directories are accounted for. “Reviewed” describes source paths and representative transitions, not every line or every possible workflow. Earlier deep reviews remain linked where repeating them would add little.

| Module | Source coverage in this pass | Findings / next work |
|---|---|---|
| accounting | Posting service; receipts/payments; reversal; expenses; bank matching; report consumers; API/POS integration | N09, N11–N14, N16–N18, N31 |
| purchasing | Bill matching, receipts, returns, supplier workflow and API conventions | N11, N16, N22; P05 |
| sales | Order confirmation, reservations, delivery boundary and prior tests | N15, N22; X06; P04 |
| pos | Register, sale and return capabilities; request schema; cart submission | N17–N18; P07 |
| inventory | Shared writer/history, reservations, cycle count, transfers, valuation | N19, N22; P06 |
| manufacturing | Work-order completion/reversal, costing, scrap expansion, feasibility | N19–N21; P06 |
| hr | Salary API; leave; payroll drafting/void; attendance; employee relationships | N01, N23–N24; X19; P08 |
| projects | Create/archive, task create/move/assign, board/list API | N01, N24; P09 |
| crm | Directory/query, conversion, ownership, task refs, timeline context | N01, N24–N25; P04 |
| marketing | Segment, send, send analytics and list route | N01, N26; P10 |
| support | Public visitor binding, auto-reply, scoped lookup, knowledge search, channel config, draft UI | N04–N05, N08, N30; P10 |
| messaging | Membership guard, conversation lists, previews, recent messages, mentions | N06, N28–N29; P09 |
| iam | Roles/assignment, invitations, auth/domain binding, SCIM lifecycle, modules | N03, N07–N08; X01, X14 |
| routines | Create/update/delete, parser/schedule math, claim/enqueue/execute, recipient policy | N27–N28; X05, X09 |
| signals | Producer composition, authorization, failure degradation, HR example | N02, N28; P01 |
| analytics | Extractors, explainChange, askYourBusiness, permission composition | N02, N11, N19, N31; X12–X13 |
| documents | Rechecked parse/version/memory seams; prior X20 contains the detailed version/storage audit | N05; X15, X17, X20; P11 |
| creator | Proposal decision route, marketplace permission, detector, signing boundary | N34; F08, F17, X03–X04 |
| skills | Rechecked operational playbooks against actual receiving and sales paths | N16, N27; X02–X04; section 8 |

Cross-cutting coverage: kernel/session resolution, relevant API routes, DB schema/migrations/backup helper, CI/test configuration, AI adapter, app shell, chat store, API client, dialog and command palette. Not performed: a production penetration test, full browser usability study, exhaustive endpoint fuzzing, jurisdictional accounting/payroll certification, restored-backup proof, or a production-sized load benchmark. These are explicit implementation/release tasks below.

## 2. Security and operational trust findings

### N01 — Read routes bypass fine-grained authority (P0, source-confirmed)

Evidence: `apps/web/src/app/api/hr/route.ts:7` checks session/org and returns salaries and tax rates at line 45; `api/ledger/route.ts:7` calls `recentLedgerEvents`, whose projection includes full payloads (`server/kernel.ts:539`). `api/customers/route.ts:15`, `api/deals/route.ts:8`, `api/marketing/route.ts:22`, `api/projects/route.ts:18` default list, and `api/pos/route.ts:8` also have direct org-scoped reads without their module read checks. The projects board branch does use a governed capability; preserve that distinction. Session detail checks owner/admin, but `api/sessions/route.ts:7` lists other people's titles without the same visibility rule.

Trigger: a signed-in same-org member with minimal permissions calls a route directly. UI hiding is irrelevant. With a DB role that serves these queries, sensitive information can be returned; a restrictive RLS role may instead cause failure, which is not an acceptable authorization design.

Implementation: enumerate every route/action/export and give each an explicit permission plus record/field audience. Introduce narrow directory projections for legitimate cross-module pickers instead of granting CRM financial access to everybody. Make sensitive reads use governed query capabilities or an explicitly shared authorized read service. Apply the same checks before cache lookup and before serializing results. Financial audit access needs its own permission; redact payloads according to viewer authority. Session list/detail use one visibility predicate.

Proof: two organizations, owner, HR-only, cashier and zero-permission member; verify route, capability, export, list, search, count and cached response behavior. Assert denied responses contain neither sensitive values nor identifying metadata. Use the actual non-owner runtime DB role. Roll out route guards before exposing new read surfaces.

### N02 — Aggregate capabilities can reveal denied source data (P0, source-confirmed)

Evidence: `modules/signals/src/index.ts:54` invokes all producers with only org/time; `server/kernel.ts:99` composes accounting, HR, CRM, inventory, support and documents producers unconditionally. HR's producer returns named lateness histories (`modules/hr/src/signals.ts:45`). `signals.read` alone therefore controls a cross-domain feed. `analytics.explainChange` and `askYourBusiness` require `analytics.report` while calling financial/CRM queries directly (`modules/analytics/src/index.ts:197`, `:264`), unlike extractors that declare source permissions.

Implementation: producer descriptors declare module and source permissions; aggregator checks actor, installed modules and field audiences before executing a producer. Pass an authorized context, not just `orgId`. Composite analytics must enforce the intersection of the relevant source permissions and module entitlements. Suggested actions need independent action authority; they must not disclose draft payload fields the viewer cannot see. Do not solve this with UI filtering after sensitive values have been fetched.

Proof: `signals.read` without `hr.read` cannot see named HR evidence; disabled modules contribute no restricted data; `analytics.report` alone cannot retrieve accounting facts. Failure of one allowed producer yields a visible partial-coverage state, not an all-clear.

### N03 — Domain identity is bound by an unverified email string (P0, source-confirmed path; deployment reproduction required)

Evidence: `server/auth.ts:13` enables password sign-up/auto-sign-in without requiring email verification. `server/session.ts:24` trusts the returned email; `server/kernel.ts:439` finds the domain user by email and loads memberships. SCIM creates domain users/memberships separately (`api/scim/v2/Users/route.ts`). Installed Better Auth sign-up code creates `emailVerified: false`; sign-in checks verification only when configured. This matters when a domain identity exists before an auth account: a registrant claiming that address can reach the domain binding without demonstrated mailbox ownership. It is not a claim that an existing password account can be bypassed.

Implementation: bind a stable auth subject/provider identity to a domain user. Require a verified email or trusted IdP assertion before claiming pre-provisioned membership or accepting an invitation. Normalize emails consistently without using email as the permanent identity key. Backfill existing subject mappings through a controlled migration; ambiguous collisions go to review. Preserve access for existing verified users and a clear resend/change-email path. Official [Better Auth email/password guidance](https://better-auth.com/docs/authentication/email-password) documents the verification control; assess the installed version as the executable authority.

Proof: pre-provision a synthetic domain user with no auth account, sign up without mailbox verification, and prove no organization access; verify successful invitation/SSO linkage only after the identity proof. Include case variations, concurrent first login, email change and account recovery. Do not test using real coworkers' addresses.

### N04 — Public customer support binds identity from visitor input (P0, source-confirmed; model disclosure needs an end-to-end proof)

Evidence: `api/support/public/route.ts:103` finds an existing customer by submitted email and binds the conversation; the response supplies its ID. With auto-reply enabled, lines 180–201 generate and publish a customer-bound draft. `modules/support/src/index.ts:275` exposes that customer's invoice facts. Widget settings default auto-reply to true (`packages/db/src/schema/index.ts:1985`). The public embed token identifies the organization; it is available to website visitors and cannot authenticate a customer. Existing thread read/write checks org plus conversation ID, without a separate visitor credential.

Implementation: anonymous visitors get a separate unverified contact and a per-conversation secret/session. Link to an existing customer only after a signed-in portal claim, email challenge or staff verification. Before verification, permit published public KB answers and general inquiry intake only. After verification, allow a minimal customer-safe projection, never drafts/internal notes merely because they are tenant-scoped. Hash visitor credentials, support rotation/expiry, and recheck conversation state before publication. A browser origin allowlist is useful abuse control, not customer authentication.

Proof: knowing a victim's email and public widget token must reveal no account facts. A visitor credential for thread A cannot read/write B. Test escalation racing an auto reply, token rotation, replay, expiry, deleted customers, denied lookups and model prompts requesting confidential fields. Containment belongs in code before expanding public auto-reply.

### N05 — Support knowledge retrieval has no publication audience (P0, source-confirmed)

Evidence: `support.searchKnowledge`, `modules/support/src/index.ts:334`, retrieves any matching org memory under `support.read`, including document chunks. It does not restrict results to published support knowledge. Org scope prevents a different problem—cross-tenant retrieval—but does not make payroll documents safe customer-facing material.

Implementation: memories/chunks inherit source ACL, audience, version, validity and deletion state. Public support reads only explicitly published knowledge; staff tools use authorized internal sources. Existing unlabeled chunks default to internal/restricted and require publication review. Reuse X20's provenance model rather than adding a second knowledge store with incompatible rules.

Proof: seed synthetic public policy, internal margin note and employee document; public and support-only contexts never receive restricted chunks in vector or keyword fallback, snippets, citations or caches. Revocation must invalidate derived retrieval artifacts.

### N06 — Private message previews bypass conversation membership (P0, source-confirmed)

Evidence: `api/conversations/route.ts:10` lists every org conversation and the latest message's first 80 characters. `modules/messaging/src/index.ts:101` similarly lists conversation metadata without membership filtering. Detailed message access checks membership at `:176`, so the list boundary contradicts the detail boundary. `readMessages` orders ascending then limits, returning the oldest messages despite promising recent messages (`:182`).

Implementation: share one membership-scoped query for list/detail, fetch authorized latest-message previews in a bounded query, and use a stable `(createdAt,id)` cursor. Fetch newest N then render chronologically; support explicit older-history pagination. Validate mention targets against org and conversation audience before notifications.

Proof: a nonmember sees no DM title, preview, activity timestamp or count. With >100 messages, the default thread view includes the latest and pagination loses none with equal timestamps. Preserve the existing detail membership guard.

### N07 — Role and SCIM lifecycle leave authority gaps (P0/P1, source-confirmed omissions; lifecycle investigation)

Evidence: `iam.assignRole` replaces user roles without a last-owner check (`modules/iam/src/index.ts:98`). SCIM deletion removes membership and invitations but leaves `user_roles` (`api/scim/v2/Users/[id]/route.ts:30`); re-provisioning can revive those grants. `resolveForOrg` itself does not verify membership (`server/kernel.ts:487`), relying on callers. The SCIM collection and single-resource routes duplicate authentication/deactivation logic with different rate-limit behavior. Invitation acceptance reads pending status outside its transaction and later replaces roles (`api/invite/[token]/route.ts:58`).

Implementation: shared identity lifecycle service with transactional invitation claim, last-owner protection, active-membership checks, immediate access revocation, and an explicit reactivation policy. Re-provision to a fresh least-privilege state unless an authorized restoration is requested. Revoke delegated runs/API credentials where appropriate; do not destroy the historical attribution. Give SCIM tokens expiry, rotation, scoped administration and auditable issuance. Consolidate resource/collection behavior; add unsupported-operation responses rather than implying full SCIM support.

Proof: removing/reassigning the last owner is blocked or uses verified transfer; suspended members cannot execute queued work; SCIM delete/recreate does not resurrect old powers; concurrent invite acceptance and revocation have one deterministic winner. New tests must cover genuine membership, not only an injected permission Set.

### N08 — Several settings/state changes bypass the capability contract (P0 for support exposure; P1 generally)

Evidence: support channel GET lazily inserts settings and POST can toggle auto reply/rotate token with session+module checks only (`api/support/channels/route.ts:16`, `:47`). `api/org/route.ts` PATCH writes agent persona directly, SCIM token/SSO administration uses direct writes, and conversation creation writes header/member rows separately. Some routes have admin checks; the finding is not that all are unauthenticated. Their audit, transactional and approval behavior differs from the architecture's one-path promise.

Implementation: classify bootstrap, auth/SCIM and personal-preference exceptions explicitly. Move business settings and conversation creation into governed capabilities with scoped permissions and transactional effects. GET must not create a bearer token as a side effect. A human-only invitation can remain a deliberate policy, but its risk classification, approval semantics and audit must agree with that policy; do not claim every IAM action is identity-class while inviteMember is `write`.

Proof: denied member cannot change support exposure or persona; GET causes no mutation; token issuance returns its secret once and audit logs only a reference. Failed conversation membership insert leaves no unusable header. Repeated mutation requests return one receipt.

### N09 — Database integrity guarantees are not established by migrations (P0, source inventory confirmed; live DB unverified)

Evidence: `packages/db/src/schema/index.ts:374`/`:399` define journal headers/lines with ordinary columns, foreign keys and indexes. Inspection of committed migration SQL found no `CREATE TRIGGER`/`CREATE FUNCTION` establishing balanced-at-commit journals or posted-document immutability. RLS policies do exist. `postEntry` asserts balance in application code. Architecture prose claims triggers/grants and DB-enforced financial invariants; the inspected repository does not substantiate that claim. A live database may have out-of-band objects; that would itself be deployment drift to resolve.

Implementation: first enumerate live catalog constraints/triggers/grants and compare a clean migration build. Specify permitted header metadata changes separately from immutable financial content: POS currently patches a source link after posting in the same transaction. Add nonnegative/single-sided line checks, same-tenant account/parent relationships, and a deferred commit-time balance/entry-completeness check or a constrained posting interface with equivalent negative proofs. Enforce immutable posted lines and append-only audit under the runtime role; separate migration privileges. Do not attempt a cross-row sum using an ordinary row CHECK: [PostgreSQL 16 constraints](https://www.postgresql.org/docs/16/ddl-constraints.html) explains its limits.

Migration: audit existing inconsistencies first; quarantine/reconcile with accounting ownership, never silently rewrite history. Stage constraints, validate existing rows, then enable enforcement. Ensure fixtures no longer depend on illicit post-commit edits.

Proof: clean migrated DB plus production-equivalent role rejects unbalanced commit, mutation/deletion of posted lines, cross-org account attachment and ledger deletion; permits valid multi-line transaction and governed compensation. Tests of `assertBalanced` alone do not satisfy this gate.

### N10 — Backup fallback may protect a different database (P0 for production migration safety, source-confirmed risk)

Evidence: `packages/db/src/migrate.ts`, `dockerDump`, parses only username/database from the configured URL and runs `pg_dump` inside the default local container. On host client absence/version mismatch, a remote connection can therefore fall back to a same-named local database. Nonempty output plus exit zero does not establish target identity. The helper snapshots on each run before checking for pending migrations, prunes to ten files, and has no explicit dump deadline. `apps/web/src/instrumentation.ts` migrates on each boot unless disabled.

Implementation: explicitly restrict container fallback to the verified local development target or use a connection to the actual target from the container. Verify database/server identity and schema migration watermark, stream completion and destination durability. Production uses a separate migration job and verified backup/PITR policy, with a non-DDL runtime role. Check for pending migrations before an expensive snapshot. Add bounded timeouts and robust stream-error handling; retain recovery points by policy, not merely last ten application starts. Never print connection secrets in errors or process diagnostics.

Proof: simulate remote target A and local container B with the same database name; fallback must refuse B. Test missing binary, disk-full output, stalled dump, concurrent starts and restore of a synthetic snapshot. A file path or successful dump process is not a restore proof.

## 3. Money, trade and operational correctness

### N11 — Outstanding balances have diverged across consumers (P0, source-confirmed)

Evidence: AR payment checks `paid + payment <= total` without credits (`modules/accounting/src/index.ts:305`); AP has the same omission (`modules/purchasing/src/index.ts:262`). Dashboard working capital uses total minus paid and age since issuance; analytics aging uses issuance/creation age and total minus paid (`modules/analytics/src/datasets.ts:97`); support invoice lookup also ignores credits. Credits exist as a separate persisted field. Thus a 100 invoice with a 40 credit and no payment can still accept a 100 payment and appear as 100 due in some surfaces. Dashboard non-void filtering can include drafts. This is more than a chart-label problem.

Implementation: one pure document-balance contract plus authorized query projections: gross, credits, allocated receipts, refunds/unapplied credit, remaining collectible/payable amount and lifecycle eligibility. Use due dates for overdue status, an explicit as-of date, and consistent currency/rounding rules. Reject payment on ineligible drafts/voids. Lock the document while validating/applying money; recompute at approval execution. Audit historical disagreements rather than replacing all balances with `max(0, ...)` and concealing customer credit.

Proof: partial/full credit before and after payment; overpayment; refund; void; future due date; exact due-date boundary; simultaneous payments. Invoice detail, aging, dashboard, support, cash forecast, statements and analytics must reconcile to the same facts. Capture legitimate customer credit separately from debt.

### N12 — A generic journal reversal is not a complete business undo (P0, source-confirmed)

Evidence: `accounting.reverseEntry`, `modules/accounting/src/index.ts:445`, mirrors journal lines but does not pass the original currency, reject a second reversal of the same original, or compensate payment/document balances. Payment declares it as its inverse. POS declares an inverse using an `entryId` absent from its returned output (`modules/pos/src/index.ts:111`, `:122`, `:244`). Payroll void guidance also directs executed runs toward journal reversal without a payroll lifecycle repair.

Implementation: separate manual-journal reversal from `reversePayment`, `refundSale`, `reversePayrollPosting` and other domain compensations. They preserve currency, update/append subledger allocation state, link original effect IDs, and are unique/idempotent at the business-operation level. Paired FX entries must reverse as a coherent settlement. Block generic reversal for protected source types or route it to their domain workflow. Render exactly what can be undone, what has downstream dependencies and what requires a correcting document.

Proof: pay→reverse→pay produces correct GL, invoice balance, bank reconciliation and receipt; foreign reversal retains currency; second/replayed reversal has no second effect; POS inverse input is valid and undoes stock, drawer and money together. Conformance must exercise inverse input generation against actual outputs, not only check that a named capability exists.

### N13 — Closed-period enforcement is distributed and incomplete (P0, source-confirmed omission; concurrent close needs proof)

Evidence: `accounting.payExpenseClaim`, `modules/accounting/src/index.ts:1490`, calls `postEntry` without `assertPeriodOpen`. `modules/accounting/src/posting.ts:80` does not perform that guard despite its introductory description. Other callers do, making correctness dependent on remembering an extra step. A check followed by posting also needs coordination with a simultaneous period close.

Implementation: make effective posting time mandatory in the shared posting command; validate closed-period state there under a lock shared with close/reopen. Model exceptional year-end closing entries explicitly so a guard cannot be bypassed with an arbitrary flag. Use one clock/date basis. Validate pre-resolved account IDs against org and posting eligibility. Capability-level previews remain useful, but the transaction owns final validation.

Proof: every posting producer, including expenses, POS, payroll, valuation and FX, refuses a closed period. A synchronized close/post test commits one valid serial order. An allowed historical correction uses its approved open-period date and retains the original business date separately.

### N14 — Bank matching checks identity, not economic equivalence (P0/P1, source-confirmed)

Evidence: `accounting.matchBankTransaction`, `modules/accounting/src/index.ts:1840`, verifies referenced rows belong to the org and conditionally claims an unmatched statement line. It does not compare amount, currency, direction, bank account or prior allocation of the payment. The conditional claim is valuable and should remain. It prevents two decisions on one line; it does not establish that the decision reconciles the bank.

Implementation: add reconciliation allocations and remaining amounts. Start with exact one-to-one matches in the same currency/account; expose fees, splits, grouped settlements, transfers and FX differences as explicit reviewed alternatives. Prevent a payment being fully allocated twice. Match suggestions carry evidence and confidence, but deterministic conservation governs final application. “Reconciled” requires an as-of statement opening/closing balance and unexplained difference of zero, not simply zero unmatched rows.

Proof: matching 100 bank inflow to 10 payment is rejected; two lines cannot each consume the same full payment; opposite direction/currency mismatches fail; split allocations conserve amounts; unmatch restores availability. P03 provides the human workflow.

### N15 — Repeated items can exceed available stock within one order (P0 for fulfillment, source-confirmed)

Evidence: `sales.confirmOrder`, `modules/sales/src/index.ts:202`, plans all reservations before inserting them, rereading the same available quantity for each line. Two lines for the same item can each reserve the same availability. POS checks stock per line before inserting movements in a similar shape. Cross-request races add a separate investigation; a single repeated-item request already exposes the planning error.

Implementation: aggregate demand by inventory identity, consume a running available budget, then allocate back to stable order-line IDs. Lock stock/reservation identities in a stable order before checking and writing. Customer credit exposure must include the chosen definition of outstanding commitments, not merely currently invoiced AR. Reservation links must identify the originating line and the fulfilled/released quantity.

Proof: stock 10 with repeated lines 7+7 reserves at most 10; all-or-nothing mode refuses and partial mode records exactly 4 backordered. Two buyers racing for the last unit cannot both win. Delivery, cancellation and partial delivery conserve allocated quantities; disable/reenable inventory cannot silently turn a stocked line into a service.

### N16 — Purchasing needs explicit receipts, stable lines and cumulative matching (P0/P1, source-confirmed)

Evidence: `purchasing.receiveGoods`, `modules/purchasing/src/index.ts:409`, indexes lines ordered by UUID as a human “line number,” inserts stock only for item-linked lines, and derives receipt completion solely from stock movements. Non-stock service lines cannot progress through this receiving contract. It does not limit receipt quantity to remaining ordered quantity. `createBill` (`:107`) checks each input line against prior bills before inserting this bill, so repeated references within the new bill do not consume each other's allowance; it also does not establish that the bill's vendor matches the referenced PO's vendor. `returnGoods` (`:859`) limits by historically received quantity, not current stock/lot availability, and leaves order status unrecomputed.

Implementation: stable line IDs plus explicit positions; receipt header/lines with accepted, rejected, returned and remaining quantities. Tangible receipt writes stock through the shared service; service acceptance records a milestone/quantity without fake stock. Aggregate bill allocations per PO line within a command, validate vendor/currency and lifecycle, and reserve remaining billable quantity under lock. Overreceipt requires configured tolerance and explicit authority. Returns link the original receipt, current location/lot and supplier credit follow-up.

Proof: service-only and mixed POs can complete; repeat line references cannot overbill; wrong vendor fails; partial receipts/returns/bills reconcile; returned consumed stock is rejected or follows an explicit exception; display line 1 always identifies the same line. This is an implementation deepening of X06, not a second goods/services model.

### N17 — POS human contract drops stock fields and loses the cart on failure (P0/P1, source-confirmed)

Evidence: `api/pos/route.ts:65` sale-line schema omits `sku` and `taxMinor` supported by the capability. The page creates description/price lines, and the completion handler always `setLines([])` after `post` (`(app)/pos/page.tsx:380`); `post` reports failure/pending but does not return a success discriminator (`:105`). A failed or approval-pending submission therefore clears the basket. This is a concrete human/agent parity failure.

Implementation: share the sale command schema; use stable product identity and goods/service behavior from X06. Return typed `completed | pending_approval | failed | outcome_unknown`. Preserve cart/draft on failure, retain a locked pending-sale record while approval waits, and clear only on a verified completed receipt. Make retry use the same operation ID. Add barcode/manual lookup, quantity edits, tax treatment and cash tender/change without requiring technical units from the cashier.

Proof: 422, 403, 202, disconnect-after-commit and reload each preserve or recover the correct basket state and do not double-sell. Human and agent submissions produce equivalent tax and stock effects. Test the actual route/page, not only `pos.completeSale` directly.

### N18 — POS sale and return records do not close the full loop (P0, source-confirmed)

Evidence: `modules/pos/src/index.ts:185` inserts invoice header/payment but no invoice lines, so item-level analysis and printable receipts cannot reconstruct sale lines from the canonical invoice schema. Sale invoice currency is omitted while `postEntry` resolves organization base currency. `returnSale` (`:347`) mirrors the full original entry, updates credits and stock, but never adjusts a cash drawer. Existing partial credit can make `refundable` smaller than the full journal it mirrors. Stock restoration loses location/lot fields. A “card” sale records accounting facts, not proof of payment-gateway capture.

Implementation: persist immutable sale lines, payment tender type, currency, tax and stock allocation with the sale. Returns select refundable quantities/amounts, return disposition and refund tender; recompute tax from original facts. Record a drawer movement in the current authorized open shift, or explicit later-shift refund, instead of rewriting a historical closed drawer. Match external capture/refund references when a connector exists. Reuse domain compensation from N12.

Proof: sale→full/partial return gives correct lines, stock at original/chosen destination, credits, currency and drawer. Cash/card/closed-shift paths differ correctly; existing credit cannot produce an excessive refund; damaged goods do not silently return to sellable stock. Exactly one provider refund on retries is a connector release gate, not a current capability claim.

### N19 — Valuation projections disagree; one loses transferred value (P0, locally reproduced pure projection)

Evidence: `manufacturing.avgUnitCost`, `modules/manufacturing/src/index.ts:39`, maps history without `valueNeutral: reason === 'transfer'`. Inventory valuation correctly includes that flag (`modules/inventory/src/valuation.ts:23`). A local synthetic replay of receipt 1 unit at 100, full transfer out, then transfer in returns value **100** with the flag and **0** through manufacturing's projection. This proves the projection error; no real stock was changed. Analytics stock value instead uses latest known cost (`modules/analytics/src/datasets.ts:158`), which is a different method from moving average.

Implementation: one authoritative valuation projection/service used by stock report, manufacturing and analytics; pass semantic movement types, stable event order and valuation method explicitly. Store a deterministic sequence as timestamp ties are not an economic ordering. Add checkpointed projections only after replay equivalence is proven. Unknown cost stays visibly unknown and should block cost-sensitive posting where required. Quantify historical impact before proposing corrective entries.

Proof: transfer round trips, zero-stock transitions, multiple receipt prices, timestamp ties, returns and production all reconcile; query projections match independent replay; correction preserves immutable movement history and is separately approved.

### N20 — Work-order completion commits stock before updating the order (P0, source-confirmed; crash/race reproduction required)

Evidence: `completeWorkOrder`, `modules/manufacturing/src/index.ts:324`, loads the order in one transaction, calls `postRun` which owns another transaction (`:226`), then updates produced quantity/status in a third. A crash leaves stock produced with a stale order. Competing completions can overwrite totals. A fresh run reference is generated, but no durable run→work-order row is written; `reverseProductionRun` mirrors movements without reducing the order's produced total or reopening it.

Implementation: production-run header bound to work-order ID, command ID, BOM revision and completion sequence. Lock order, validate remaining quantity and inputs, post movements and update order in one transaction. Refactor `postRun` to accept that transaction. Reverse a run once, compensating linked order and inventory state together after downstream dependency checks. Infer legacy links only with reliable evidence; ambiguous historical runs stay explicitly unlinked.

Proof: injected failure between every effect rolls back the whole completion; two partial completions conserve total; reversing a completion restores remaining quantity and appropriate status; cannot reverse output already consumed without a governed downstream correction.

### N21 — Feasibility and production use different BOM rules (P1, source-confirmed)

Evidence: `checkProductionFeasibility`, `modules/manufacturing/src/index.ts:871`, loads only direct edges and omits scrap; execution loads the graph in `scrapAdjustedRequirements` (`:49`). Execution then applies the maximum scrap rate for a component across all org edges, including potentially unrelated assemblies, rather than accumulating each path's edge semantics. A comment in feasibility says scrap is applied, but the edge projection omits it.

Implementation: define scrap/yield semantics with manufacturing stakeholders; implement one pure explosion using the selected BOM revision, per-edge quantities, rounding and scrap. Decide explicitly whether stocked subassemblies are consumed or recursively built. Feasibility, shortage calculation, cost preview and execution use the same function and availability/reservation basis. Distinguish material feasibility from machine/labor scheduling; do not promise a precise completion date from a simple average.

Proof: nested assemblies, shared component reached by different paths, unrelated high-scrap BOM, fractional quantities, reserved components and cycle rejection. “Can make N” followed by immediate execution with unchanged inputs must agree.

### N22 — Inventory commands need aggregate-level consistency and lot checks (P0 for races; P1 usability, investigation grounded in source)

Evidence: `recordStockMovement`, `modules/inventory/src/shared.ts:34`, is currently an insertion helper, not an invariant-enforcing service. Reservations, transfers and cycle counts perform read/check/write without a common lock. Transfer feasibility checks item/location quantity; lot movement needs the corresponding lot availability check. Cycle-count drift guard compares total on-hand (`modules/inventory/src/index.ts:511`), so equal net stock after intervening movements is not detected. POS/purchasing bypass even the shared insert helper.

Implementation: one inventory command service owns org/item/location/lot validation, quantity semantics, available-to-promise, ordered locking and unique operation effects. Use item+location+lot projections with movement watermarks; cycle counts retain the observation's scope and watermark. Distinguish uncounted lines from counted zero, allow safe rebase with explicit review, and never apply a global count to a specific bin. Define one numbering allocator rather than repeated MAX+1 per module. Keep lots and reservations usable without manufacturing enabled.

Proof: concurrent reserve/sell/transfer/count operations cannot produce impossible balances; item A's lot cannot move item B; full quantity and valuation replay matches projections; a receipt+sale during counting is detected even if net quantity is unchanged. Seed enough history to assess lock duration and query plans.

### N23 — Payroll and leave need a correctable, date-aware lifecycle (P0 correctness; P1 employee UX)

Evidence: drafting payroll rejects any existing period row (`modules/hr/src/index.ts:237`); void leaves that row and the schema's unique org/year/month index (`schema/index.ts:984`), blocking redraft. Staff selection uses currently active employees, not employment effective during the target month; the monthly calculation does not use hire/termination dates. `leaveBalance` (`:731`) selects starts after Jan 1 without an upper boundary, includes later years and misses leave spanning from the previous year. `unpaidLeaveDaysInMonth` (`erp-core/src/payroll.ts:88`) sums overlapping intervals; a local synthetic check counted two copies of the same day as **2** days. Attendance uses fixed 09:00 UTC (`hr/index.ts:640`).

Implementation: payroll period with revisioned draft runs and at most one active posted revision; snapshot employment/pay rules and worked intervals as of the period. Voiding a draft permits a fresh revision. Union leave intervals and clip to period boundaries; separate taken, approved future, pending, entitlement and carryover. Model work calendar/timezone/shift before marking lateness. Payroll localization/tax rules require validated jurisdiction packs and specialist sign-off; current simple math should remain labeled simple payroll posting.

Proof: void→redraft→execute; mid-month joiner/leaver; later deactivation followed by historical payroll; overlapping/cross-year/leap-day leave; future leave does not count as taken; local shift boundaries. Posted-run correction reconciles liabilities/payments and payslips, not just GL lines.

### N24 — Foreign references and assignees need active scope validation (P0 for tenant links; P1 project lifecycle)

Evidence: `hr.requestLeave`, `modules/hr/src/index.ts:120`, inserts caller employee ID without an org-scoped employee lookup; the FK is global ID only. Project create/assign accepts arbitrary user IDs (`modules/projects/src/index.ts:72`, `:158`); CRM task references and assignees are weakly typed (`crm/index.ts:289`). Project creation blocks archived parents, but moving/assigning existing tasks does not recheck archive state. These are distinct from the good parent-task same-project validation already present.

Implementation: shared scoped reference loaders plus composite tenant FKs where practical; active membership and task eligibility for assignees. Model archive as an explicit rule—read-only by default, reopen capability for changes. Link tasks to a typed, authorized business reference and retain a departed user's attribution while offering reassignment. Employee self-service uses `self` identity mappings and separate permissions, not broad `hr.write` over arbitrary employee IDs.

Proof: foreign employee/customer/task/location IDs fail with non-disclosing errors under both owner and runtime DB roles; inactive/nonmember assignee fails; archive/move race is deterministic; existing historical relationships survive deactivation. A role with permission is still constrained to valid references.

### N25 — CRM lookup ignores the query; conversion can leave partial work (P1, source-confirmed)

Evidence: `crm.listCustomers`, `modules/crm/src/index.ts:82`, declares `query` but execution ignores it, returning an arbitrary first 100 active records. Human `/api/customers` returns at most 500; neither supplies complete server search/pagination. `crm.convertLead` (`:235`) can insert a customer then update the deal in a separate operation; retries/races can create orphan/duplicate customers. Some simple mutations report success even if no row changed, such as deactivateCustomer.

Implementation: permission-aware server search with normalized matching, stable cursor and exact-ID lookup for selected values beyond the first page. Transactionally claim a lead conversion with a unique operation ID, explicit existing/new-customer choice and duplicate review. Return `not_found`, `already_applied` or committed receipt instead of unconditional success. Provide customer edit/restore/merge as governed workflows with references preserved; merging needs a preview of affected records.

Proof: customer beyond row 500 is found by name/email and preserved in pickers; query really filters; concurrent conversion creates one relationship; failed update leaves no orphan; deactivated customer isn't silently offered for new sales. Duplicate names remain distinct records.

## 4. Automation, intelligence and shared experience

### N26 — Campaign “send” records recipients without sending (P1, source-confirmed product-contract defect)

Evidence: `marketing.sendCampaign`, `modules/marketing/src/index.ts:64`, inserts `marketing_sends` and sets `sentAt` but calls no provider/outbox. `campaignAnalytics` counts these rows as sent. A unique campaign/customer index already exists; preserve it. Segment spend totals include invoices without a posted-status or credit-adjusted definition. Campaign generation may include customers with no usable delivery address because the query does not select one.

Implementation: make campaign state explicit: draft, audience reviewed, queued, sending, completed/partial/cancelled. Add recipient delivery rows and outbox with one provider operation ID per recipient; recheck consent and address validity just before dispatch. Record provider accepted/delivered/bounced only with the corresponding evidence. Migrate existing rows as legacy recorded recipients, never assert they were actually delivered or automatically send them retroactively. Define spend using N11's canonical metric. Separate outbound audience approval from ordinary draft-write permission.

Proof: no connector yields “delivery unavailable” and preserves draft; opted-out/invalid-address contacts never dispatch; duplicate run creates no extra provider effect; mid-campaign unsubscribe is honored; failed recipient can retry independently. Useful first scope is a repeat-customer announcement with a test message and recipient preview, not a large campaign builder.

### N27 — Routine edits and parsing change schedule meaning (P1, partly reproduced)

Evidence: `modules/routines/src/index.ts:199` recomputes next run whenever an existing schedule is present, including name-only edits. Structured creation accepts `HH:MM` by shape, not range, and update does not repeat creation's required-field checks. Text parser's interval regex is not fully anchored (`erp-core/src/routines.ts:56`): a local call with `every 30 minutes on weekdays` returned an unrestricted interval. Scheduling uses server-local `setHours`/`getDay` with no org timezone. Deleting then invoking its create inverse loses enabled/trigger/token identity and can re-create a previously disabled routine as scheduled.

Implementation: one discriminated schedule schema for create/update/text normalization; reject unconsumed qualifiers and impossible times. Store IANA timezone, wall-clock intent and missed-run/DST policy; show next three occurrences before confirmation. Rename/prompt changes preserve due time. Use reversible archive/restore for routines, preserving identifiers and enabled state; token restoration follows an explicit security policy. Preserve current workflows with migration labels identifying their old server-time basis.

Proof: rename has unchanged due time; 99:99 and incomplete weekly schedule fail; unsupported qualifier asks a targeted question; timezone/server relocation gives same intended local schedule; DST repeated/missing times follow policy; restore doesn't silently enable automation.

### N28 — Routine claims, authority and health status are overstated (P0/P1, source-confirmed windows; concurrency proof required)

Evidence: `server/routines.ts:63` claims by updating last-run state; next-run advancement occurs in separate later statements, then enqueue occurs separately. Another worker can claim the still-due row in the gap; a crash after reschedule can lose the occurrence. This extends F04's recurring-invoice issue to routines. Execution uses a fixed broad read bundle, not the creator's current delegation. It instructs posting to a general channel, but messaging requires membership and the system actor has `id: null`, so that path is refused. Final routine notifications are org-wide; setting the run to `ok` and swallowing errors/NO_ACTION can hide blocked tools. Queued execution does not recheck `enabled` before starting.

Implementation: transactional occurrence claim+enqueue with unique `(routineId,scheduledOccurrence)` and lease/fencing from B03. Persist a scoped mandate with owner, allowed reads/actions, recipient audience and expiry; re-evaluate suspension, module state and permission revocation at execution. Outcomes include completed-no-findings, findings, partial, blocked, failed and cancelled. A disabled routine cancels future/unstarted occurrences according to explicit policy; in-flight cancellation reports what already happened. Use a designated authorized channel/recipient, never automatically broadcast HR/finance findings.

Proof: two workers/worker death cannot double-enqueue or lose a due occurrence; failed tool cannot produce all-clear; revoked owner or paused routine cannot initiate another sensitive run; channel membership and notification audience hold. Test agent-free schedule execution separately from live-provider behavior.

### N29 — One person's read mark clears a broadcast for everyone (P1, source-confirmed)

Evidence: `api/notifications/route.ts:76` updates the broadcast row's shared `readAt` when `userId IS NULL`; GET uses that same column to count unread for every recipient. A second click returns not-found rather than an idempotent read acknowledgment. Routine notifications use these broadcasts.

Implementation: immutable notification event plus per-user receipt/read/dismiss/snooze state with unique notification/user key. Define recipient audience at delivery, and recheck visibility at read time. Group noisy events by subject, allow quiet hours and digests, and link to the exact authorized record. Read is not resolved; an underlying overdue task remains unresolved until the business condition changes.

Proof: A reads a broadcast, B remains unread; repeat marking read succeeds idempotently; revoked recipients cannot reopen content; pagination/counts agree. Migrate old shared read marks as uncertain recipient state, not fabricated per-user read history.

### N30 — Async UI results are not consistently bound to their origin (P0 for wrong-recipient draft; P1 other races)

Evidence: support `makeDraft` awaits using the current conversation ID then stores a bare draft string (`(app)/support/page.tsx:124`). Conversation switching clears that string but does not prevent the prior request returning later; `sendDraft` uses the newly active ID (`:139`). A draft generated for A can therefore appear in B's composer. `chat-store.ts` is a process-local browser singleton with no organization key; session ID, queue, abort controller and reset operations share mutable state. Shell org switch changes a shared cookie and redirects. Old tabs and in-flight results require explicit tenant-context testing. Server session ownership guards still exist; this finding does not assume those guards are bypassed.

Implementation: draft/result state carries orgId, recordId, input revision and request ID; accept a response only if those still match. Server send references a persisted draft bound to its conversation, with edit/approval metadata. Scope chat stores and queues by org/session; generation counters discard stale deltas after reset. Each business command states expectedOrgId and rejects cookie/context mismatch. Multi-tab switch warns/reloads stale context before writes. Distinguish stopping a stream from cancelling a committed job.

Proof: delay A's draft, switch to B, receive A's result: B remains untouched and send-to-B is rejected server-side. Switch org mid-draft/in another tab; reset mid-stream then send again; queued message never migrates to another tenant. Cancellation must reconcile receipts before offering retry.

### N31 — Analytics answer fields and citations are factually inconsistent (P1, source-confirmed)

Evidence: `askYourBusiness`, `modules/analytics/src/index.ts:297`, reads `r.total_minor` from an extractor returning `totalMinor`; output can say “undefined minor.” It labels all-time top customers “this period.” Collections citations request invoice IDs from an aggregate bucket dataset that has none. `explainChange` groups customer names/product descriptions rather than stable identities, and drill samples only period B, so a lost customer's period-A evidence is absent (`:164`, `:238`). Financial extracts also need N11's metric definitions.

Implementation: typed result rows with stable dimension IDs and separately rendered labels; remove broad record casts masking schema mismatch. Every answer declares metric/version, basis, period, currency, as-of time and source dataset reference. Aggregate citations open the filtered dataset; individual references open actual records. Drill covers both compared periods with totals and pagination. Label gross invoiced value distinctly from recognized revenue; no inferred accounting equivalence.

Proof: no undefined/empty citations; same-name customers stay separate; a customer present only in A has accessible evidence; contributions sum to the defined metric difference and drill totals reconcile. Chart and narrative derive from the same dataset object. X12/X13 remain the analytics/report architecture.

### N32 — Modal/keyboard semantics are incomplete (P1, source-confirmed implementation gap; browser proof pending)

Evidence: `components/ui.tsx:333` focuses a modal and handles Escape/restoration, but does not trap Tab or make background content inert. Command palette separately implements a dialog/listbox (`(app)/command-palette.tsx:93`) without complete focus containment or a linked active-option announcement. App tabs have ARIA roles, but roles alone do not supply keyboard behavior.

Implementation: consolidate on a well-tested accessible dialog/focus implementation and shared tab/combobox behaviors, preserving the current visual design. Provide keyboard alternatives to drag, visible focus, named icon actions, associated field errors, status announcements and reduced-motion support. Model drawers, confirmations and nested dialogs with correct return focus. W3C's [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) defines the expected containment/restoration behavior; use it as guidance alongside user testing, not as a claim of compliance by itself.

Proof: keyboard-only create/edit/approve/cancel journeys, screen-reader field/error announcements, focus after deletion, nested modal closure, narrow viewport and 200% zoom. Automated checks supplement manual assistive-technology verification. Follow repository next-dev-loop requirements when implementing UI changes.

### N33 — Response semantics blur pending, failed and unknown outcomes (P1, source-confirmed)

Evidence: `apps/web/src/lib/api.ts` marks HTTP 202 as `ok:true`, parses invalid/missing JSON as null even for success, and translates failures by matching English text. Several routes repeat raw `req.json()`/casts while others use safe parsing. `chat-store.ts` checks a response body but not HTTP status/content type, and ignores a final buffered fragment without a newline. Unknown/disconnected action results currently lead toward retry language that may duplicate a committed operation.

Implementation: extend existing API helper rather than adding a parallel transport. Use Zod-parsed discriminated receipts, stable domain error codes, field issues, request/operation IDs and explicit `retryable`/`outcome_unknown`. Preserve safe user details and keep SQL/provider/raw exception context in restricted server diagnostics. Bound body/list/page sizes and deadlines. Streaming has a versioned event schema, terminal state and reconnect checkpoint; malformed/truncated streams cannot look completed. Module/API-disabled and permission-denied states have consistent responses.

Proof: invalid JSON, HTML error response, null success payload, permission loss, rate limit, partial stream, 202 and timeout-after-commit each produce the correct UI state with retained draft and action-specific recovery. No sensitive payload is exposed in a technical-details panel merely because it is collapsed.

### N34 — Creator review decision races and permission naming need tightening (P1, source-confirmed)

Evidence: proposal POST checks `in_review` then updates by ID without conditional status/version (`api/proposals/route.ts:48`), allowing concurrent reviewers to overwrite decisions. `creator.listMarketplace` requires `accounting.read` (`modules/creator/src/index.ts:379`), coupling browsing to unrelated financial authority. Coding-agent discovery routes expose host tool inventory to any member. Signed-manifest verification exists, but executable sandbox/deployment proof remains F17; do not relabel “listed/installed” as active verified code.

Implementation: compare-and-set decision with expected proposal revision, immutable reviewer decision event and separate permissions for propose/review/install/browse. Self-review policy is an explicit organizational choice; changing evidence/diff invalidates prior approval. Restrict host/tool diagnostics to developer administration. Preserve independent publisher trust, artifact digest, installed version and activation state from X03/X04 and E02–E04.

Proof: competing approve/reject yields one decision plus conflict; changed diff cannot reuse approval; marketplace browsing needs no accounting permission; failed capability conformance prevents activation and discovery. Implementation evidence is executed proof tied to an exact code revision, not generated test text.

### N35 — Performance and maintainability hotspots are identifiable but unmeasured (P1/P2, source-confirmed query shapes)

Evidence: dashboard reads whole AR/AP/deal sets and all-history trend then selects six months in memory (`api/dashboard/route.ts`); conversation list does a query per row; inventory valuation does a history query per item; manufacturing repeatedly loads item histories; payroll queries leaves per employee. Several UIs fetch bounded first pages and filter them locally. `accounting/src/index.ts` is 2,643 lines and its page 1,616 in this snapshot. Size alone is not a defect, but duplicate schemas, response adapters, math and business transitions have demonstrably drifted in N11/N17/N31.

Implementation: measure query count, scanned rows, lock time, memory and p50/p95 under stated org/data sizes. Push date filters/aggregation into SQL, page directories, batch histories/joins, and avoid unbounded Promise.all fan-out. Introduce replay-verified valuation/read projections where measured replay cost warrants them. Index from real query plans—candidate org+status+due-date, org+sequence, conversation+createdAt+id—not blanket indexes. Keep permission+tenant+metric-version in every cache key and invalidate after committed events. Separate modules by cohesive use case inside the modular monolith; extract shared contracts before splitting UI files. Reuse the API helper and existing pure math. Consolidate duplicate SCIM handlers and response adapters after behavior is characterized.

Proof: baseline and changed workloads use the same dataset/hardware; correctness totals and query counts are recorded. Tenant/permission change cannot reuse stale privileged cache. Large scans/exports become jobs with cancellation and resource limits. Do not add microservices, a general graph database, a new state library or a warehouse solely to make this plan sound enterprise-grade.

### N36 — The normal test command omits existing module suites (P0 verification foundation, source-confirmed)

Evidence: root `package.json` runs `turbo test`; only manufacturing and signals among the 19 module packages currently declare a `test` script. A filesystem/package-manifest inventory found **19 existing module `.test.ts` files in packages with no test script**. These include accounting, purchasing, sales, inventory, HR, POS, CRM, projects, documents, analytics, creator, support and marketing. The web Vitest config includes only its own `src/**/*.test.*`; it does not discover those module files. The observed root run had eight task groups, consistent with this narrower scope. Some module behaviors are exercised indirectly by web tests; that does not mean these omitted test files ran.

Implementation: wire a coherent Vitest workspace or package scripts for all intended suites, with explicit DB setup and bounded worker concurrency. Make test discovery inventory itself a CI check: each test file is assigned to a known suite or an explicitly documented exclusion. Separate pure, isolated DB, route/browser, live-provider and demo proofs. DB tests must use dedicated disposable databases or run-scoped fixtures; inspect cleanup before parallelizing (for example HR tests delete probes by a shared name). Disable Turbo result caching for environment-dependent DB proofs or include a defensible database/schema/environment identity; a cached test run cannot attest to the current database. Extend F15's CI demo coverage inventory.

Proof: deliberately fail a representative formerly omitted module test and demonstrate root/CI failure, then restore it and run the full configured matrix. Publish executed, cached, skipped and excluded coverage separately. Required DB proofs run after a clean migration under the intended roles. Fix the existing job-query failure by establishing its cause; do not hide it while enabling more suites. This package precedes any claim that subsequent domain fixes are fully verified.

## 5. Features users could enjoy enough to return for

These are product hypotheses, not a commitment to ship every idea. Each starts from a repeated job, has a useful manual path with AI off, and uses the same governed commands when AI helps. Start with P01–P04 for one pilot cohort; deliver module-specific features only where that cohort needs them. Adoption, task success and retained usage matter more than chat-message volume.

### P01 — A calm “My work” home that explains the next step

**Job and journey:** “What needs my attention, and what can I finish now?” Show at most a few ranked items across approvals, follow-ups, stock exceptions and personal tasks. Each card says what changed, why it matters, due date/owner, evidence, and one primary action. “Supplier delivered 8 of 10; accept 8 and leave 2 outstanding” is actionable. A general “purchasing issue” is not. Separate waiting-for-others from work the user can do now. Let users snooze with a reason, delegate, or mark the signal unhelpful; an unresolved underlying condition must not disappear permanently.

**Lean implementation:** build on signals and existing tasks/approvals, with source permissions, stable subject IDs, per-person receipt state, related resource links and coverage timestamps. Deterministic ranking first; AI summarizes an authorized evidence set. Preserve app navigation for people who prefer module work. Role-specific home defaults can be changed without rebuilding the workspace.

**Success/proof:** in a pilot, measure time from opening home to first completed useful action, resolution time, false-positive dismissals and repeated snoozes. Coverage failures must appear as “last checked … / check unavailable,” not zero problems. No algorithmic worker performance score or public employee-lateness feed.

### P02 — Drafts that survive interruptions and a clear finish receipt

**Job and journey:** a receptionist creates a customer while answering a call; a buyer starts a PO and waits for a price. Show “Saved draft” with timestamp, retain edits across reload, and offer “Continue where you left off.” Success returns a concise receipt: what changed, actor/principal, pending steps and “Open customer/order.” If network state is uncertain, “Checking whether this completed” resolves the operation ID before retry.

**Lean implementation:** per-user/org/record draft revision, autosave of safe editable fields, optimistic conflict detection, and command receipts from B02/X08. Sensitive HR/account data uses server-side storage with scoped retention; do not dump all form values into shared localStorage. AI can prepare a draft, explain its suggestions and highlight changed fields; manual editing remains ordinary form work.

**Success/proof:** no lost data on the sampled reload/navigation/failure flows; lower re-entry and duplicate creation; pending approval never masquerades as completion. First implementation: POS basket and purchase order. Generalize only after those work, rather than build a universal form designer.

### P03 — A reconciliation workspace that makes the reason visible

**Job and journey:** import a bank statement, see suggested matches side by side with amount/date/reference evidence, accept the exact ones in a previewed batch, then work a short exception queue. Explain “100 received, 97 banked, 3 fee” and offer the correct governed accounting treatment. Display remaining unexplained difference and statement boundary. Closing the workspace should feel like finishing a finite job.

**Lean implementation:** N14 allocation model, statement import identity and idempotency, deterministic exact-match rules first. AI proposes ambiguous candidate descriptions but cannot invent allocations. Batch results show succeeded/pending/failed per line; a changed statement invalidates the preview. Support bank fees and one-to-many settlement only after the exact path is correct.

**Success/proof:** reconciliation completion time and rate of reversed matches, with conservation tests and a known-answer statement. Avoid a conversational-only accounting screen; experts need dense comparison and keyboard control.

### P04 — Customer and supplier pages that remember the relationship

**Job and journey:** open a customer and see current balance, last interaction, open orders, promised follow-up and the next relevant action. Answer “What did we promise?” without opening five modules. Show pending deliveries and disputes separately from overdue debt. A supplier page connects late receipt, current order, bill and contact history. A compact visible timeline distinguishes a human action, an agent acting for someone and a scheduled action.

**Lean implementation:** extend existing customerTimeline with typed refs, audience filtering, pagination and stable detail routes; add a counterpart supplier timeline. Store promised dates/owner at the business record, not only in chat. Offer a draft follow-up with source citations; ask before external send. Customer merge/edit flows from N25 prevent a beautiful page built on duplicates. Support “copy from previous order” as a reviewed new draft with current availability/prices.

**Success/proof:** users find the latest promise and balance in a short task without help; follow-ups missed, duplicate records and unnecessary app switches decline. Avoid a giant all-data profile, generic sentiment score or automatically sent relationship email.

### P05 — A receiving desk for the person holding the delivery

**Job and journey:** scan/find the PO; see expected goods; enter “8 accepted, 1 damaged, 1 missing”; attach evidence; finish with “8 added to shelf, 1 in quarantine, 1 still expected.” Show service acceptance as “Milestone completed” rather than asking for stock. Create a draft supplier follow-up/credit request from the discrepancy. Preserve partial work when the phone sleeps.

**Lean implementation:** N16 receipt/line model, stable item/lot/location identifiers, exception reason and photo/document refs. Scan is an input convenience, never a sole identifier authorization. The backend supports submitted-but-pending approval before stock effects. Start with online mobile-friendly entry and resumable draft; defer offline final posting until a demonstrated warehouse need.

**Success/proof:** fewer wrong-line receipts and less supplier-chasing re-entry; partial deliveries and services complete without workaround. Test keyboard-only and narrow screen with one hand; retain a desktop bulk-entry view.

### P06 — A warehouse/build assistant that answers “why not?”

**Job and journey:** request a build or delivery quantity; see “Can make 8 now; 2 more need component C” with exact arithmetic and links. Offer a draft purchase, revised build quantity or later promise. Counts present one bin/item at a time and explain why a changed snapshot needs review. Visual stock labels distinguish on hand, reserved, available, expected and quarantined.

**Lean implementation:** unified N19/N21/N22 valuation, BOM and availability rules; lightweight shortage worksheet with snapshot watermark. A proposed action remains a draft under policy. Add lot/expiry priority only for stocked products that use it. Future capacity planning is a separate scope; current material availability must not be marketed as a factory schedule.

**Success/proof:** feasibility agrees with immediate execution, shortage explanations are understood, mistaken reservations/counts decrease. No autonomous purchasing based on stale or incomplete availability.

### P07 — A forgiving, fast checkout and shift close

**Job and journey:** scan/type a product, adjust quantity, take tender, see change and a proper receipt. Park a sale for a returning customer without losing the active queue. A return starts from the original receipt and asks only for quantity, reason/disposition and refund method. Shift close explains each difference through sales, refunds, cash-in/out and opening float.

**Lean implementation:** N17/N18 first, then draft parking, barcode entry and receipt lookup. Distinguish card payment recorded from payment processor confirmed. Shortcuts are visible and optional; common tasks have large touch targets. A manager override explains the exact limit and produces a linked approval, without exposing admin controls to the cashier. Multiple registers need per-register constraints; the present one-open-session-per-org behavior should not be silently advertised as multi-register retail.

**Success/proof:** timed representative sale/return/shift journeys, no cart loss, no duplicate sale on retries and no unexplained drawer differences caused by the software. Defer loyalty tiers, broad promotions and offline financial posting until stable checkout earns daily use.

### P08 — Employee self-service with private, understandable records

**Job and journey:** “How much leave can I book?”, “Has my expense been approved?”, “Why is this payslip different?” Provide a personal page showing entitlement/taken/planned leave, reimbursement progress and a simple payslip comparison with approved explanations. Managers see pending decisions and coverage conflicts without exposing medical details to coworkers. An employee can correct a mistaken time entry through a visible review flow.

**Lean implementation:** verified user↔employee mapping, self/manager/HR permissions, N23 date/payroll corrections, effective calendars and document ACLs. Explain pay differences from deterministic payslip components; AI paraphrases those facts only. Provide supporting document requests with minimal disclosure. Onboarding/offboarding checklist links equipment/access/tasks to responsible people, extending X19 without building a new HR suite first.

**Success/proof:** fewer “where is my claim?” interruptions; employees can find their balance/status without help; salary and sensitive absence reasons never enter general notifications or search. Do not use lateness signals to generate employee rankings or unsupported disciplinary judgments.

### P09 — Personal commitments connected to business work

**Job and journey:** turn “I will call them Friday” into a proposed task linked to the customer, with owner and due date. “My work” shows CRM, project and approval commitments without requiring the user to understand separate task tables. A colleague can see who is waiting on whom and hand work over with context. Completing a task opens the relevant action/record instead of merely moving a card.

**Lean implementation:** a small common work-item projection over existing domain tasks, with typed links and source permissions; retain domain ownership. Add personal saved views, URL filters, keyboard navigation and explicit reassignment for leavers. Optional templates for repeated onboarding/month-end tasks use X05's bounded workflow service. Don't migrate everything into one generic polymorphic table just to share a list.

**Success/proof:** fewer missed due items, less duplicate entry and an understandable handoff to another person. AI proposes tasks; it does not treat every sentence in a conversation as a commitment. No time-tracking surveillance or automatic effort scores.

### P10 — A trustworthy customer communication desk

**Job and journey:** one inbox distinguishes customer request, internal note, AI draft, approved reply and delivered message. A draft shows the evidence it used and a clear recipient. Public visitors can get useful general answers immediately; account-specific answers explain the short verification step. For an announcement, preview audience, excluded contacts and an actual test message, then review delivery results.

**Lean implementation:** N04–N06/N26/N30, governed external-delivery outbox, recipient-bound draft and publication-audited knowledge. Add promised-response time and human handoff acknowledgment; channel adapters normalize threads without sharing credentials. Start with the existing web support channel and one real email adapter. A sent reply cannot be “unsent”; offer a correction draft rather than fake undo.

**Success/proof:** wrong-recipient drafts impossible at the backend boundary, fewer stale AI replies after staff takeover, verifiable delivery state and useful recovery for failures. No automatic private-account answer based on typed email; no decorative AI confidence percentage without calibrated meaning.

### P11 — Guided import and document review with visible uncertainty

**Job and journey:** drop a spreadsheet/invoice, preview detected type and column mappings, resolve only uncertain fields, then see a dry-run summary and errors linked to source rows/pages. “Save this mapping for this supplier/file format” reduces repeat work. Import can pause and resume; rejected rows remain downloadable with reasons. Finish links to created records and the import receipt.

**Lean implementation:** reuse X15/X17/X20: staged files, immutable source versions, authorized previews, exact money/date parsing, duplicate detection, map versions and resumable job state. OCR extraction includes page/region citations; changing a source invalidates proposals. Suggestions never become accounting facts solely because model confidence is high. Sandbox/example files remain clearly separate from live books.

**Success/proof:** first useful import completed with few manual corrections; repeat imports don't duplicate records; source totals reconcile; unsupported file/model route gives an alternative. No “import succeeded” when only part committed, and no screenshots/documents automatically uploaded as telemetry.

### P12 — Progressive onboarding and a developer setup that earns trust

**Job and journey:** ask the business type and first desired outcome, then offer “send an invoice,” “receive stock,” “manage a project” or “import data,” filtered by selected modules. Gather only prerequisites for that outcome. Show optional steps as “Set up later,” retain the decision, and resume from the actual state. Explain an unavoidable requirement at the moment it matters. Let experienced users choose manual setup and enter directly. A developer should get a deterministic local setup, a health diagnosis, seeded synthetic data and one working demo before connecting a paid model.

**Lean implementation:** extend the existing multistep wizard, not another onboarding flow. `api/setup/route.ts` currently gives the same product/vendor/widget/coding-agent checklist to every org and marks team invitation done even for any historical invite; replace with persona/module/permission-aware progress. “Host coding agent installed” is a technical administration task, not a required first-business step. Keep self-hosted and managed setup distinct; use `doctor`-style checks for DB version/extensions/migration state/runtime role, optional model capability, email and worker heartbeat. No automatic use of production data for a demo.

**Success/proof:** newcomer reaches one useful result, skips optional work without guilt or dead ends, returns and resumes; service-only/project-only businesses avoid irrelevant stock setup. Measure first-value time and abandonment by step with X10 privacy rules. Developers can start core workflows without an AI key and diagnose a missing dependency without reading stack traces.

## 6. UX and UI delivery rules

### Shared interactions to build once

| Surface | Default experience | Backend/interaction requirement | Proof |
|---|---|---|---|
| Lists and pickers | Search actual records, save a useful view, return to the same filters/scroll | Server search/pagination, stable ordering, selected-ID hydration; filters in URL; views scoped to user/org | Record outside first page is discoverable; back/forward restores view |
| Record detail | Clear status, next valid action, related evidence and timeline | Authorized resource resolver; transition availability with reasons; actor/provenance | Read-only and action-disabled states explain why without leaking fields |
| Create/edit | Few required fields, sensible editable defaults, progress saved | Draft revisions, field validation, expected record/org version | No lost edits on server error, navigation or conflict |
| AI assistance | Contextual “Help with this” on the active record | Authorized context snapshot, typed questions, recipient-bound drafts, citations | AI-off journey still completes; no redundant clarification of visible facts |
| Bulk actions | Preview what will change and exceptions | Exact selected IDs/query snapshot, per-item authority, idempotent receipts | Some succeed/some await approval/some fail without ambiguous all-success banner |
| Approvals | Decision summary first; changed amounts/parties/risk clear | Expected version, current authority, separation-of-duties policy, receipt | Stale approval requires re-review; no double execution |
| Errors | Preserve work; explain field/action and next step | Typed errors, committed/pending/unknown state | A retry button exists only where retry is safe |
| Empty states | Explain the first useful action and optional import/example | Module/persona/permission relevance | Zero data differs from missing access, failed load and stale coverage |
| Notifications | Actionable, deduplicated and individually dismissible | Recipient audience, per-user state, grouped subject, exact link | Read mark is private; unresolved work remains visible appropriately |

### Visual hierarchy and interaction polish

Retain the current identity and token system. Redesign the information hierarchy around the business task: page title/status, one primary action, useful record summary, then detail. Use predictable placement for save/cancel, filters and totals. Tables need right-aligned exact amounts, clear currencies/units and sticky context where it helps; internal minor-unit/thousandths representations should never be the ordinary input language. Show an em dash/“not available” for unavailable facts, not a fabricated zero.

Use text/icons alongside color for status. Increase density only where a user chooses it or repeated expert work benefits. A compact mode and comfortable mode should share functionality. Avoid repeated card borders, decorative gradients, charts with no decision value and perpetual activity animations. Motion should communicate a transition and respect reduced motion. Loading skeletons should preserve layout and not replace useful stale data without an explicit freshness label.

Mobile priority is selective: approval, expense/receipt capture, leave request, receiving and customer lookup. Desktop priority is reconciliation, bulk editing and large tables. Do not cram the entire ERP into a mobile bottom navigation. Explicitly test long names, translated labels, RTL if supported, locale number/date input, daylight-saving transitions, zero/three-decimal currencies, high zoom, keyboard entry, screen-reader output and slow connections.

### Ideas deliberately held back

Do not start with an unrestricted workflow canvas, fully autonomous payroll/bank transfer, a separate app for every AI role, gamified employee scores, an all-purpose report designer, blockchain audit marketing, a full CRM marketing-automation suite, or a microservice per module. Start with guided repeatable workflows, strong receipts, correct numbers and recoverable everyday work. Introduce complexity when named pilot jobs demonstrate the need and a simpler interface cannot serve them.

## 7. Implementation sequence, migration strategy and measurement

N items add to the existing W0–W7 programme. They do not authorize silently replacing it or declaring historical milestone checkmarks invalid. Update milestone claims where their actual proof is narrower than the prose.

| Package | Owner(s) | Scope and dependencies | Concrete exit artifact |
|---|---|---|---|
| I0 — Baseline and containment | Security + platform lead | Reproduce N01–N10 with synthetic identities; map every route; establish runtime DB role/schema; N36 suite discovery and existing test failure | Evidence register with each claim confirmed/ruled out/open; affected paths contained; baseline tests and skipped coverage documented |
| I1 — Identity/read boundaries | IAM + API + security | N01–N08; source ACLs and public visitor identity; independent of new product UI | Denial matrix across routes/capabilities/search/export/cache; verified identity lifecycle; no public private-data path |
| I2 — Domain transaction spine | Kernel + accounting + DB | Prior B01/B02/B03; N09, N11–N16, N22; align lock/idempotency/receipt contracts | Atomic business effects, correct balances, DB negative proofs, concurrency regressions, repair inventory of affected historical data |
| I3 — Operational corrections | Inventory/manufacturing + HR + product | N17–N25 after the required I2 service contracts | POS return/shift proof; transfer/production valuation proof; payroll correction proof; reference/assignment safety |
| I4 — Reliable communication and automation | Jobs + integrations + AI | N26–N30, N34, X05; needs I1 and durable effect/receipt handling | Real external-delivery states, recipient-bound drafts, recoverable occurrences and pause/revocation proof |
| I5 — First enjoyable vertical journeys | Product + UX/UI + domain owners | P01/P02/P04 first; choose P03/P05/P07/P08 by pilot, not all at once | Complete human and AI-assisted journey with direct links, preserved drafts, useful failure states and measured usability |
| I6 — Understanding and scale | Analytics + performance + platform | N19/N31/N35, X12/X13; correct metric/authority contracts first | Reconciled reports, working citations, measured query/latency improvements and budget/retention controls |
| I7 — Expansion from evidence | Product + creator/platform | Remaining P ideas and self-development improvements after pilot | Evidence-backed prioritization; independent implementation proof and staged release; removal/defer decisions for unused complexity |

**Parallel work boundaries:** I1 identity/read services and pure I2 financial math can proceed independently once shared contracts are written. POS, purchasing and manufacturing can then use those contracts concurrently. Do not have multiple agents independently invent receipt, inventory-lock, money or permission conventions. Resolve those interfaces before dispatch. UI design prototypes can proceed early; UI implementation must not camouflage missing backend guarantees.

### Migration and rollout protocol

For each affected domain, distinguish new schema, backfill, enforcement and behavior activation. Add columns/tables first with explicit unknown/legacy states; backfill from reliable sources; validate invariants; switch writers/readers together where correctness requires it; enforce constraints; remove old paths only after compatibility proof. Reversible code rollout cannot undo an irreversible external effect or schema deletion. Keep the prior readable data shape during staged deployment and specify a roll-forward repair for posted financial effects.

Required historical reviews include credited-vs-paid balances, repeated reversals, unlinked production runs, valuation divergence, cross-tenant foreign references, stale role grants, broadcast read state and marketing rows claiming delivery. Reports for these investigations should contain minimal necessary identifiers and totals, available only to authorized operators. Do not automatically rewrite books, resend campaigns, restore old privileges or republish internal documents.

Deploy behind server-enforced rollout controls per affected workflow. A kill switch pauses new agent/connector actions, preserves existing evidence, and offers manual work where safe. Define treatment of already queued/approved work and drain it deliberately. Per X09, AI assistance may remain default-on; new powers still require permissions and policy. Approval of a product feature is not approval to move real money or email real people during testing.

### Evidence-driven measures

Set initial targets with the pilot rather than claim unmeasured performance improvements. Suggested provisional usability targets: at least 90% unassisted task completion on each selected first-use journey; no loss of saved draft under the specified interruption tests; a material reduction in median completion time against the current UI, with error/reversal rates no worse. Report task cohort, sample size and distribution. Do not translate a tiny scripted test into a general adoption claim.

For runtime, collect p50/p95/p99 command latency, query count/rows scanned, lock wait, queue age, model cost per completed job, cache correctness/freshness, duplicate-effect attempts prevented, delivery uncertainty, and time to resolve failed work. Define synthetic representative datasets (small service business, busy retailer, larger multi-team org) and concurrency before setting SLOs. Provider latency, DB latency and frontend rendering must be measured separately. Baseline the existing route before applying Cache Components/instant navigation using the repo skills and matching Next.js docs.

For user value, measure first useful outcome, repeated weekly workflow completion, correction/re-entry rate, meaningful approvals handled, missed commitments and notification dismissal. X10 governs collection: no prompt/customer/employee content in product telemetry; diagnostics/screenshot submission remains voluntary, previewed and redacted. The product should remain useful if telemetry is disabled.

## 8. Handoff contract for implementing agents using unlazy discipline

This section is for **future coding agents implementing a selected package**, not a claim about this audit. Use the project's available unlazy skill and its actual instructions at implementation time. Do not turn these prose acceptance criteria into checked boxes without evidence.

Before editing, the implementation lead chooses one bounded package and writes its acceptance ledger. Read ARCHITECTURE, ROADMAP, relevant ADRs, this plan's N/P IDs and applicable code/Next.js docs. Revalidate the reported defect against the current commit; source anchors in this document are a starting point and may move. A code change since this audit can invalidate a finding. Record the before behavior or failing test, approved behavioral contract, touched paths, owners, dependencies and data migration scope. A ruled-out finding gets a reason and evidence, not a cosmetic patch.

Each assignment must specify:

| Contract field | Required content |
|---|---|
| User outcome | Named actor, trigger, observed before behavior, intended after behavior and explicit exclusions |
| Domain invariants | Money/quantity conservation, state transition, identity/permission and recipient rules |
| Interfaces | Input/output schemas, expected record/org version, operation ID, receipt/error shape, events and resource links |
| Migration | Existing data detection/backfill, unknown states, constraints, mixed-version compatibility and rollback/repair |
| Scope | Exact owned paths; shared-contract owner; no concurrent overlapping edits without coordination |
| Proofs | Named unit/property/integration/route/browser/concurrency scenarios; required local dependencies; independent expected results |
| Completion evidence | Exact code revision, commands, exit status, test totals, skipped tests, environment/DB role, browser artifacts where applicable |
| Review | Domain specialist for financial/payroll rules, security for access boundaries, UX reviewer for user journey |

The riskiest gates must be runnable where feasible. Good examples are “two requests competing for the last unit leave one valid allocation,” “a cashier cannot read payroll through any covered endpoint,” and “failed checkout retains the cart and retry returns the original sale.” Bad substitutes are “a file exists,” “the mock was called,” “capability name registered,” “expected output printed,” or an assertion copied from the function's own result.

Implement complete behavior, then reread it as a domain owner, hunt integration/security/performance defects and polish the user journey. Preserve other local work. Add appropriate property tests for financial invariants and concurrency tests for transactional boundaries. Do not weaken assertions, suppress real exceptions, broaden credentials, remove RLS or convert failures into success to make checks pass. Any accepted limitation remains explicit in the ledger and user-facing behavior. Generated test source is never recorded as an executed test result.

Verification requires the repository gate `pnpm typecheck && pnpm lint && pnpm test`, plus affected database/demo proofs and actual route/browser flows. A module unit test bypassing the API cannot prove human/agent parity. Use real non-owner runtime roles for DB isolation tests; worker leases and provider mocks must include crash/replay cases. Live-provider tests are a separately labeled set with spend limits and synthetic data. No actual customer sends or production financial changes are implied by this plan. For UI work, use next-dev-loop after edits, including loading, error, permission-denied and narrow-screen states.

Before requesting release review, another reviewer re-runs consequential checks against the exact proposed revision and reviews failure evidence. For creator-generated code, verifier contracts/test fixtures must be protected from unilateral rewriting by the generator. Promotion depends on passing required gates; unresolved failures and skipped required proofs are a handoff, not completion. Use independent regression checks when shared services change. Update ADRs for adopted long-term decisions, CHANGELOG for behavior, and regenerate pnpm lockfile for dependency changes.

A concise implementation report should state what changed, why, the actual proofs, known limitations, migration/backfill results and any remaining required release step. Link the concrete diff and evidence. Do not claim a milestone is enterprise-ready because a self-maintained ledger says “all met.”

### Initial implementation briefs

| Brief | User-visible outcome | Required proof beyond general checks |
|---|---|---|
| N01/N02 access boundary | Each role sees only authorized business data, including summaries | Matrix tests against API, aggregate tools, list/count/detail and cache with a non-owner role |
| N03/N04 verified binding | Legitimate users/customers reach their own records; anonymous visitors still get general help | Synthetic pre-provisioned account and victim-email widget negative cases; positive verified flow |
| N11/N12 balance and compensation | Payment/credit/refund screens and reports agree; supported undo restores business state | Property conservation plus real DB pay→credit→reverse/refund→reconcile across modules |
| N15/N22 stock consistency | Last-unit sale/reservation decisions are reliable | Synchronized contenders; repeated item lines; location/lot checks; replay totals |
| N17/N18/P07 checkout | Cashier can finish, pause, retry or return a sale without losing it | Browser/API human parity, 202/422/disconnect-after-commit, drawer and receipt reconciliation |
| N19/N20/N21 production | Material preview matches the build; completion/reversal updates all related records | Transfer value regression, nested scrap cases, injected crash and two concurrent completions |
| N23/P08 payroll correction | Voided draft can be corrected; leave and payslip reflect the right period | Effective employment, overlap/calendar boundary cases, revision and posting immutability |
| N26/N30/P10 communication | Correct recipient gets a verifiable delivery; late drafts cannot cross threads | Delayed A→B draft race; provider failure/retry/consent revoke; legacy rows not resent |
| N27/N28 routine trust | Schedule meaning, paused state and run history remain accurate | Parser full-consumption, timezone/DST, two workers, revoke/pause before execution |
| N31/P01 analytics and attention | Clear numbers, real citations and honest partial coverage | Known-answer datasets with same-name entities, lost-period contributors and producer failure |

## 9. Verification record and remaining limits

The source review accounts for **19** module directories, measured from `modules/`, and **36** finding entries N01–N36 plus **12** product hypotheses P01–P12. These are not 36 independently exploited vulnerabilities. Evidence classifications in each entry matter.

Three non-mutating synthetic calculations were executed locally with `pnpm exec tsx`, importing the current pure source functions: (1) transferred stock valued at 100 with the inventory semantic flag versus 0 through manufacturing's current field projection; (2) duplicated one-day leave interval counted as 2; (3) `every 30 minutes on weekdays` accepted as an unrestricted 30-minute interval. These checks demonstrate the pure calculation/projection behavior only. No production data, account impersonation, external message or financial effect was used.

The repository-required `pnpm typecheck && pnpm lint && pnpm test` was run in this pass. Typecheck passed, with 25 cached workspace tasks. Lint passed with existing warnings. Tests failed at `apps/web/src/server/jobs.test.ts:58`: expected `lastError` to contain `no document`, received a wrapped failed documents SELECT. The web suite reported 208 passed / 1 failed across 15 passing / 1 failing files; Turbo reported seven successful cached test tasks and one failed task. The SQL failure's underlying cause is not established by the assertion output. Resolve schema/runtime-role/test-environment causes before changing the assertion. The earlier intermittent products hook timeout did not recur in this run.

No new implementation, migration, UI runtime change, commit or push was made for this audit. N36 documents the module suites omitted by the root command. Full business demos, browser proofs, attack reproductions and load/restore tests were not rerun; no implemented milestone is being certified. Source links/IDs and documentation whitespace are checked during final review. Existing local README/assets/.gitignore work is preserved.

External references checked for this planning pass are limited to the official Better Auth, PostgreSQL and W3C pages cited beside the relevant decisions. Product ideas and prioritization are judgments grounded in the repository and the user's goals, not external competitive research or guaranteed commercial outcomes.
