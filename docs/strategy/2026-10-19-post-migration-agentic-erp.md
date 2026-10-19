# From migration to a governed operating loop

Response to the Monday 19 October 2026 Agentic ERP brief. Baseline: branch
`react-go-migration`, commit `3b0d7bd0`, CI run `39203144543` green.

## 1. Where the product actually is

The 15 October strategy plan was written against commit `e2d5574`, before the
migration finished. Several of its blocking findings are now closed:

- The Next.js application is retired (`b050abf1`). Vite and Go are the only
  runtime.
- CI is green on a fresh database, including the migrated-chain proof and the
  Go worker suites.
- The Go signal producers are registered in the API process, not only in
  tests. `signals.Register` runs from `apps/api/cmd/api/main.go:198`.
- Durable runs can be created, dispatched, approved, resumed, and receipted.
  The purchase-order worker proof in
  `apps/api/internal/jobs/durable_purchase_order_run_integration_test.go`
  already covers a two-step run with an approval gate.
- MCP is Go-owned. `apps/api/internal/httpapi/ai_tools_mcp.go` is the live
  surface.

This changes the conclusion, not the direction. The remaining constraint is
not migration and not agent count. It is that no single business workflow has
been proven from detection through verified outcome on live data, with
authority enforced outside the model and reliability measured.

## 2. What the new brief changes

The 19 October brief is about three things: verifiable authority, complete
business processes, and continuous evaluation. Each maps to work already in
the repository, but each exposes a specific gap.

| Development | What it validates | What CBOS should do | What CBOS should not do |
| --- | --- | --- | --- |
| ServiceNow AI Passport | Authority must be checked by the execution layer at run time | Add a versioned responsibility mandate and cumulative commitment limits to the existing executor checks | Build a separate identity or policy platform |
| Intuit and Sequence | Buyers pay for a complete process, not isolated tools | Finish inventory replenishment, then quote-to-cash, as complete workflows | Start a usage-billing platform before ordinary quote-to-cash is reliable |
| DigitalOcean agent evaluation | Agent quality is a lifecycle, not a launch check | Add scenario evals and regression cases beside the Go tests | Adopt a new vendor or a second observability stack |
| ServiceNow EmployeeWorks | Business users can configure automation, but only inside a constrained catalogue | Keep routines as structured, reviewable configurations | Ship a free-form agent builder |
| External evidence services | External facts can inform a decision but cannot authorize one | Keep external evidence in a separate context layer | Let a scraped price or catalogue become transaction authority |

The common signal is not "more autonomy". It is that autonomy becomes
sellable only when authority is explicit, the process completes, and quality
is measurable. Those are one design problem, not three programmes.

## 3. The wedge: one complete operating loop

The first proof remains the Inventory Exception Manager described in the
15 October plan. It is still the right wedge because it crosses signals,
inventory, purchasing, approvals, durable execution, and verification without
requiring a new module or a payment provider.

The loop is:

1. Detect a real stock risk from live records.
2. Investigate stock, reservations, demand, incoming supply, and supplier
   evidence.
3. Calculate a defensible response in domain code.
4. Explain the evidence and the uncertainty.
5. Prepare a reviewable proposal.
6. Obtain the exact authority required.
7. Execute through governed capabilities.
8. Follow the resulting work across waits and restarts.
9. Verify the outcome from business records.

The value is not the inventory feature. It is the reusable operating contract
that collections, purchasing, financial close, and customer follow-up can
reuse.

## 4. Delivery order

Dates are deliberately absent. Each gate is evidence, not a calendar promise.

### Gate A: close the migration with evidence (platform, one week)

- A fresh installation and an upgrade both complete representative workflows
  with the Next.js process absent.
- Route, capability, worker, and integration inventories agree with actual
  ownership.
- Production ingress is proven to use the Go and Vite paths.
- Passwords, sessions, organization selection, audit history, approvals, and
  pending jobs survive the upgrade.
- Backup restore and deployment rollback are exercised against a compatible
  schema.

This gate is mostly verification. It should not become another porting
programme.

### Gate B: deterministic replenishment planning (this slice)

Add `inventory.replenishmentPlan`, a read-only capability that reads live
stock balances, open reservations, recent sales movements, open purchase
orders, and recorded costs, then returns:

- the demand rate and variability used;
- the configured or derived lead time and its source;
- safety stock, reorder point, and target stock;
- on-hand, reserved, available, and incoming quantities;
- a suggested quantity and estimated commitment cost;
- a status and the evidence behind it.

It does not create, reserve, approve, or order anything.

The capability is exposed to Workmate and to scheduled routines with the same
input contract. The registry, manifest, and tests are updated together.

Why this first:

- It is the missing deterministic step. The existing reorder demo supplies
  sample values to a TypeScript function; it does not plan from live records.
- It is read-only, so it can ship while the proposal boundary is designed.
- It gives the evaluation harness a real tool to select and a real output to
  check.
- It replaces model arithmetic with a service the model can call and explain.

### Gate C: proposal and commitment boundary (two weeks)

- A versioned purchase proposal exists as its own record, with lines, supplier,
  prices, timing, assumptions, and estimated commitment.
- Editing a proposal creates a new version and invalidates the prior approval.
- Approval binds to the exact proposal version and payload hash.
- Commitment rechecks stock, price, supplier eligibility, and mandate limits
  immediately before creating an order.
- Replaying the same intent returns the original result rather than creating a
  second order.

The current `purchasing.createPurchaseOrder` creates an `ordered` order. That
is a commitment, not a draft. It should remain a commitment capability and sit
behind an explicit proposal and authorization path. A new proposal record is
preferred over overloading `purchase_requests`, because the existing request
record has no line-level product, quantity, or price model.

An independent audit on 19 October confirmed five concrete gaps:

- `purchasing.createPurchaseOrder` is registered as `risk:"write"` with no
  money threshold, so an agent or system job can commit under the default
  policy. It inserts `status='ordered'` immediately.
- `purchasing.selectWinningQuote` is a second commit path. It inserts an
  `ordered` purchase order with one synthetic line for the whole quote
  (`apps/api/internal/capability/purchasing_requests.go:459`).
- The generic `/api/capabilities/execute` route accepts an empty `intentId`,
  so a retried write without an intent has no receipt key and can duplicate.
- Approvals bind the input hash, but not a proposal version. Execution does not
  recheck price, stock, or supplier eligibility, and the vendor lookup does not
  exclude deactivated vendors.
- No cumulative commitment limit exists. `requiresApproval` evaluates one input
  at a time.

The full boundary, in order, is:

1. Register `purchasing.createPurchaseOrder` as money risk with a zero
   threshold, so agent and system commitments always need human authority.
2. Remove the direct purchase-order insert from `selectWinningQuote`; return
   the selected quote and require the commitment capability with real lines.
3. Reject an empty intent for state-changing capabilities on the generic
   execute route.
4. Reuse the approval row as the proposal version: preparing a changed payload
   supersedes older pending approvals for the same capability and requester,
   and commitment rechecks vendor active state, price, stock, and authority.
5. Add a line-level proposal record only if editing, alternatives, and supplier
   comparison cannot be represented by the superseded approval versions.

This keeps the existing approval, receipt, and audit machinery and avoids a
second queue or a parallel authority system.

Delivered on 19 October:

- `purchasing.createPurchaseOrder` and `purchasing.selectWinningQuote` are now
  money-risk capabilities with a zero threshold. The purchase order amount is
  computed from its lines for the policy check.
- A system purchase-order job without a verified approval fails closed and
  writes no order. The approved durable-run proof still commits exactly one
  order and receipt.
- A deactivated supplier cannot receive a new purchase order or quote award.
- The public execute route requires an intent for money, destructive, and
  identity capabilities.

Still open, and not claimed as done:

- `selectWinningQuote` still creates a synthetic single-line order after its
  approval. Replacing that with a line-level commitment is the remaining part
  of the quote-to-order boundary.
- Approval versioning and cumulative mandate limits need a proposal or mandate
  record. They are the next gate, not a property of this slice. Because agent
  and system purchase commitments now always require approval, there is no
  autonomous cumulative spend to bound yet; cumulative limits become relevant
  when a mandate later permits autonomous commitments below a limit.

### Gate D: durable objective, exceptions, and records (two weeks)

- A business objective persists its completion criteria, authority reference,
  current state, evidence versions, approvals, waiting conditions, and
  verified result.
- The coordinator reuses `agent_runs` and `agent_run_steps`; it does not add a
  second queue or receipt system.
- A detected exception has stable identity, severity, evidence, owner, status,
  and a linked objective.
- Repeated detections of the same unresolved condition deduplicate.
- A failed detector is visible as a detection failure, not as a healthy
  business.
- A Decision Record connects the problem, evidence, alternatives,
  recommendation, authority, approval, actions, and verified result.

### Gate E: Workmate as the operating surface (one week, overlapping C and D)

- Reusable cards for exception, proposal, approval, progress, waiting, and
  result.
- Delivered on 19 October: a purchase proposal card backed by the stored
  approval payload, with supplier context and approve or reject in the
  conversation. The model's prose is never the authorization. After approval,
  the card reads the resulting purchase order and shows its status, remaining
  quantities, and receipts. A backend acceptance test covers plan, pending
  proposal, human approval, order, receipt, and the next plan.
- A consistent "Ask Workmate" entry that carries record context.
- The server revalidates record references and permissions.
- Leaving the conversation does not abandon accepted work.
- Changing organization clears context, drafts, cached results, and retry
  identifiers.

### Gate F: evaluation and metrics (continuous, first cases at Gate B)

Delivered on 19 October: a Settings Quality tab that runs live DeepSeek flash
scenarios against fixture tool results, with scripted tests and three first
cases: low-stock proposal, incoming supply that covers the gap, and missing
history. It measures tool choice and honesty without creating business records.
History, scheduled runs, and release metrics remain open.

- Scripted-model scenarios for: low stock with no supply, low stock with
  sufficient incoming, supplier delay, conflicting records, authority
  exceeded, and incomplete data.
- Assertions on business state, authority, duplicate effects, tool choice, and
  cost, not only HTTP success.
- Release metrics: verified completion, first-attempt correctness, approval
  rate, intervention rate, correction rate, decision acceptance, time to
  resolution, cost per verified outcome, duplicate or unauthorized effects,
  and exception recurrence.
- A required approval is not counted as an agent failure.

## 5. Authority model for this workflow

The executor already checks the signed session, membership, module enablement,
effective permissions, policy, approvals, and receipts. The missing layer is a
responsibility mandate that constrains what an acting agent may do over time.

For the inventory responsibility, a mandate should carry:

- acting identity and responsible user;
- permitted capabilities and records;
- products, locations, and approved suppliers;
- whether the system may suggest, prepare, or commit;
- per-action and cumulative commitment limits;
- currency and budget window;
- required approvals;
- expiry, escalation, and revocation rules.

Enforcement belongs in deterministic code. A model explanation, confidence
score, or signed prompt does not grant authority. Outstanding commitments
count against cumulative limits, and authority is rechecked at execution time
after any wait or worker restart.

## 6. What is deliberately deferred

Until the inventory loop reaches a verified result:

- large catalogs of named agents;
- arbitrary generated interfaces;
- new modules without demonstrated demand;
- a separate graph database or analytics warehouse;
- a new distributed workflow or event platform;
- advanced forecasting without sufficient history;
- broad autonomous payment authority;
- voice-led operation;
- a free-form automation builder;
- external evidence integrations beyond a specific proven decision.

## 7. First slice acceptance

`inventory.replenishmentPlan` is complete when:

- it is registered with `inventory.read`, module `inventory`, risk `read`, and
  a closed input schema;
- it reads live records through the runtime role and organization transaction;
- open reservations reduce available stock without being counted twice as
  demand;
- open purchase orders reduce the suggested quantity;
- insufficient history falls back to the configured reorder point and says so;
- a missing cost is reported as unknown, not as zero cost;
- items with no action are excluded by default and counted in the summary;
- Workmate and routines advertise the same contract;
- unit tests cover the math and integration tests cover tenant scope,
  permission denial, incoming supply, reservations, and no-write behavior;
- the capability manifest and changelog are updated;
- Go tests, vet, typecheck, lint, and the relevant inventory checks pass.

The next decision after this slice is the proposal representation. That
decision should be made against a working planner output, not in advance.
