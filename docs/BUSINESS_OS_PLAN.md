# Business OS Plan — Full Module Suite (M7–M13)

Status: proposed (awaiting owner go-ahead) · 2026-08-30
Input: eleven external feature-audit checklists (Accounting, Purchasing, HR,
Manufacturing, Projects, Expenses, POS, Marketing, Helpdesk, Documents,
Analytics), triaged against the codebase as built. Revenue-suite detail
(Inventory · Sales · CRM, M7–M9) lives in `docs/REVENUE_SUITE_PLAN.md` and is
not repeated here.

Governing principle (owner's words, treated as an architectural requirement):

> Each module should be useful alone. The modules should become exponentially
> more useful when combined, while the AI acts as the connective tissue that
> lets an ordinary business owner operate the whole thing without needing to
> understand the underlying ERP architecture.

## 0. The principle, made enforceable

### 0.1 What already makes "useful alone" real

- Capabilities are registered per module; `organizations.enabledModules`
  (jsonb) toggles them per org; the web shell gates UI by module
  (`useModuleEnabled`). An org can run POS-only or CRM+Sales today.
- Cross-module writes already flow through seams, not imports: the shared
  stock writer (ADR 0009), the shared posting service (ADR 0020), the
  approvals inbox, and the event ledger.

### 0.2 The four seams that make combination exponential

1. **Signal registry (M8.1)** — every module contributes needs-attention
   signals; home, app overviews, routines, and the agent consume one shape.
2. **Cross-module read capabilities** — e.g. `support.lookupOrderStatus`
   already crosses into sales/POS; `crm.customerTimeline` (M9.4) spans
   invoices, quotes, payments, deals, tasks, support, messages. Reads
   compose; writes stay governed.
3. **Advisory skills as playbooks** — `procure-to-pay`, `quote-to-cash`,
   `stock-reorder`, `month-end-close` already exist; each milestone adds
   playbooks that chain capabilities across modules.
4. **The event ledger** — one append-only, hash-chained audit spine; any
   cross-module action is reconstructible end-to-end.

### 0.3 Composition conformance (new, enforced — ADR-0035, M8.0)

The principle becomes a testable rule set:

- **No hard sibling imports.** A module must not import another module's
  internals at boot; integration effects go through declared seams.
- **Graceful degradation.** Every cross-module effect is conditional on the
  sibling module being enabled: POS sale with Inventory off → posts revenue,
  skips stock movements; sales-order confirm with Inventory off → skips
  reservations; expense claim with Documents off → no receipt attachment.
  Missing a sibling never corrupts; it simplifies.
- **Subset matrix harness.** CI boots the registry with representative module
  subsets (POS-only, Sales+Inventory, CRM+Sales, full stack, minimal) and
  runs each module's core flow; milestone demos run against subset orgs too.
- **AI as tissue, not bypass.** The agent composes modules only through
  registry capabilities + skills; it never opens a back door between modules.

Gates:

- **G0a** subset matrix: registry boots and core flows pass for all declared
  subsets
  - `CHECK: pnpm --filter @chaste/kernel test -- module-matrix`
  - `EXPECT: "matrix-ok"`
- **G0b** degradation: POS sale with Inventory disabled posts revenue, writes
  no stock movements, audit chain intact
  - `CHECK: pnpm --filter @chaste/module-pos test -- degradation`
  - `EXPECT: "degradation-ok"`

## 1. Triage of the remaining audits

Legend: BUILT (exists, governed) · PARTIAL (exists, gaps listed) · NEW ·
DEFERRED (deliberate). Evidence = capability ids / tables observed in the
registry and schema.

### 1.1 Accounting — strongest module already; depth, not rebuild

| Audit item | Verdict | Evidence / action |
|---|---|---|
| CoA, journal entries, reversals, GL, trial balance, periods, audit trail | BUILT | `accounting.*` (39 capabilities), `journalEntries/Lines`, ADR 0004, M2 |
| Invoices, numbering, due dates, status, payments, share links | BUILT | `createInvoice/recordPayment/listInvoices/shareInvoice`, `invoiceShares` |
| Quotes, recurring invoices, expense claims | BUILT | `createQuote/acceptQuote/declineQuote`, `createRecurringTemplate*`, `submitExpenseClaim/decide/pay/list` |
| Bank accounts, feeds, reconciliation | BUILT | `addBankAccount/importBankFeed/match/unmatch/exclude` |
| Sales tax config + filing; FX groundwork | BUILT | `salesTaxReport/fileSalesTaxReturn`; `fxRates/fxSettlements`, ADR 0021 |
| P&L, balance sheet, AR/AP aging, cash basis, close/reopen, year-end | BUILT | `incomeStatement/balanceSheet/arAging/cashBasisReport/closePeriod/closeYear` |
| **Cash flow statement** | NEW | direct method from the ledger → M10.1 |
| **Credit notes (AR + AP)** | NEW | reversal-style documents, ADR-0004 pattern → M10.1 |
| Customer/supplier statements; invoice reminders; payment terms | NEW | statements as rendered reports; reminders via notification seam + routine → M10.2 |
| Budgeting; assets/depreciation | DEFERRED | budget-vs-actual returns in M12 only if budgeting lands; assets on demand |
| Anomaly/duplicate detection, cash-flow forecast, "explain" | NEW (deterministic) | stats → signals; forecast from AR/AP/recurring in erp-core → M10.3 |
| Multi-company, consolidation, cost centers, analytic acct, deferred rev/exp | DEFERRED (audit ④) | design hooks only, per ARCHITECTURE non-goals |

### 1.2 Purchasing — workflow complete; add memory and intelligence

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Vendors, requests → approval, RFQ → quotes → award, POs, receipts, bills, payments, AP aging, 3-way match | BUILT | `purchasing.*` (12 capabilities), ADR 0010 |
| **Supplier lead-time & performance** | NEW | derive from receipts vs expected dates → M10.2 |
| **Purchase backorders; purchase returns** | NEW | backorder flag on short receipts; returns = reversal-style → M10.2 |
| Supplier price history / comparison | PARTIAL | data exists in POs + bills; needs extractor + report → M10.3 |
| Unusual price increases; best supplier; "what should we order" | NEW | deterministic comparisons → signals; ordering = M8 reorder loop |
| Budgets, blanket orders, MOQ rules, contracts, vendor portals, subcontracting, tenders, EDI | DEFERRED (audit ③④) | |

### 1.3 HR — core exists; structure and recruiting are the gaps

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Employees (hire/deactivate/list), leave (request/decide/cancel), time entries (log/decide/report), gated payroll (ADR 0014) | BUILT | `hr.*` (12 capabilities), `employees/leaveRequests/payrollRuns/payslips/timeEntries` |
| Departments, positions, manager/reporting structure | NEW | columns + directory UI → M11.1 |
| Employee documents; emergency contacts | NEW | documents-module linkage → M11.1 |
| Attendance (check-in/out, late indicators) | PARTIAL | maps onto `timeEntries`; light check-in/out actions → M11.2 |
| Leave balances & calendar | PARTIAL | balances derivable; calendar UI → M11.2 |
| Recruitment (openings, applicants, stages, hire conversion) | NEW | light pipeline reusing the CRM kanban pattern → M11.3 |
| AI: overload/overtime, attendance anomalies | NEW | deterministic aggregation of timeEntries → signals; decisions stay human |
| AI: candidate summarization, JD/interview drafting | NEW | draft-only, cited; hiring decisions never autonomous |
| Benefits, reviews, goals, training, self-service, succession, shift planning | DEFERRED (audit ②④) | |

### 1.4 Manufacturing — production core done; planning lite only

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Multi-level BOMs w/ scrap, work orders (draft→release→complete/cancel), production runs + reversal, cost preview, lot traceability | BUILT | `manufacturing.*` (14 capabilities), ADR 0026 |
| **Material availability ("can we produce 500?")** | NEW | BOM explosion vs stock (`bomTree` exists) → deterministic check → M11.4 |
| Work centers / operations / production steps | NEW (lite) | steps on work orders + optional work-center field; no routings engine → M11.4 |
| Production scheduling board; lead-time estimate | NEW (lite) | from historical run durations → M11.4 |
| Bottleneck/waste analysis, demand-driven planning | NEW | deterministic; feeds signals |
| By-products, quality checks, subcontracting, MRP, MPS, capacity engine, routings, shop-floor/IoT | DEFERRED (audit ③④) | |

### 1.5 Projects — greenfield, deliberately small

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Projects, tasks/subtasks, assignment, due dates, priorities, status, kanban + list, comments, activity | NEW | new `modules/projects` (projects/tasks tables); kanban reuses the CRM DnD pattern → M11.5 |
| Time tracking | PARTIAL | link tasks to `hr.timeEntries` (module-aware: works standalone without HR) → M11.5 |
| AI: status summaries; extract tasks from messages; plan drafting | NEW | summaries from ledger; extraction is draft-only via messaging reads → M11.5 |
| Dependencies/Gantt, milestones, budgets, client portal, portfolio, resource planning | DEFERRED (audit ②④) | |

### 1.6 Expenses — governed core exists; receipts and policy are the gaps

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Claim submit → decide → pay, history | BUILT | `accounting.submitExpenseClaim/decideExpenseClaim/payExpenseClaim/listExpenseClaims`, `expenseClaims` |
| Categories | PARTIAL | optional `accountCode` today; add real categories → M11.6 |
| Receipt attachment; document linkage | NEW | documents-module seam (degrades without Documents) → M11.6 |
| Duplicate receipt detection; policy limits; auto-categorization | NEW | deterministic: hash/amount-date match, limit checks → approval routing, rules-first coding (extends `documents.suggestCoding` pattern) → M11.6 |
| Mileage, per-diem, corporate cards, multi-currency expenses | DEFERRED (audit ②④) | |

### 1.7 POS — solid core; returns and receipts complete it

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Register sessions w/ float + honest variance, single atomic sale posting, stock decrement, product catalog, sales history | BUILT | `pos.openSession/completeSale/closeSession`, M2 |
| **Returns** | NEW | reversal posting + stock back in, same seam discipline → M13.1 |
| Receipts (render/print) | PARTIAL | share-link pattern exists (`invoiceShares`); receipt render → M13.1 |
| Discounts/taxes on lines; multiple payment methods; customer selection | PARTIAL | verify line-level support at slice start → M13.1 |
| Register barcode lookup | NEW | enabled by M7.3 barcode field → M13.1 |
| Multiple locations/registers; shift management; POS reports | PARTIAL | sessions exist; registers-as-locations verify → M13.2 |
| Offline mode, loyalty, gift cards, promotions engine, customer display, kitchen/tables, hardware | DEFERRED (audit ②④) | offline is explicitly rejected for now |

### 1.8 Marketing — approved to build (owner decision 2026-08-30): keep it tiny

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Audiences/segments | NEW | deterministic filters over customers + sales (analytics extractor) → M13.3 |
| Campaigns (email), templates, scheduling, opt-out, history | NEW | campaigns table + existing email/notification seam; opt-out flag on customers; send-log only → M13.3 |
| AI: copy, subject lines, segment suggestions | NEW | draft-only; human sends; segments suggested deterministically → M13.3 |
| Basic analytics | NEW | sends/bounces from the seam; **no open/click tracking** (privacy + scope) |
| Automated sequences, journeys, landing pages, forms, A/B tests, attribution, multi-channel | DEFERRED (audit ②④) | the audit itself says: don't become Mailchimp + HubSpot |

### 1.9 Helpdesk — good bones (draft-only agent already shipped); add ticketing depth

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Conversations, replies, escalation, resolve/reopen, knowledge search, order-status lookup | BUILT | `support.*` (9 capabilities), ADR 0025 — `lookupOrderStatus` is already a cross-module read |
| AI drafted replies (bound, zero model-controlled ids) | BUILT | ADR 0025, `demo:support` proves injection resistance |
| **Ticket fields** (number, priority, category, assignee, SLA-lite dueAt) | NEW | extend support conversations → M12.3 |
| Canned responses; internal notes; collision prevention | NEW | light → M12.3 |
| Knowledge base authoring | NEW | articles table; `searchKnowledge` already reads → M12.3 |
| AI: auto-categorize/prioritize, similar-ticket retrieval | NEW | deterministic rules first; model suggestions land as drafts, never auto-applied; retrieval via `searchMemory` → M12.3 |
| SLA policies, teams, CSAT, omnichannel, voice, ITSM | DEFERRED (audit ②④) | SLA-lite dueAt only |

### 1.10 Documents — the business document layer, not Google Drive

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Upload, OCR/parse (nemotron-parse), org-memory semantic search, coding suggestions | BUILT | `documents.*` (6 capabilities), ADR 0013, `documents/documentSuggestions` |
| Folders, metadata (category, refType/refId links to business records), preview/download, rename/archive | NEW | → M12.4 |
| **Expiry dates → signals** ("which contracts expire this year") | NEW | metadata + signal producer → M12.4 |
| Version history | NEW | append-only revisions (ledger discipline) → M12.4 |
| Ask across documents (with citations); extraction to structured data | PARTIAL | chat retrieval exists; formalize citations + extend `documentSuggestions` → M12.4 |
| Sharing/permissions | PARTIAL | RLS org-scoped today (ADR 0017); per-document grants deferred |
| Approval workflows, e-signature, templates, retention policies, legal DMS | DEFERRED (audit ②④) | |

### 1.11 Analytics — the place modules become understanding

| Audit item | Verdict | Evidence / action |
|---|---|---|
| Five read-only dataset extractors + `analytics.renderReport` (narrative, SVG charts, tables → HTML) | BUILT | ADR 0029, `modules/analytics` |
| Dashboards: per-app overviews + home dashboard + custom dashboards | BUILT | M-batch (`core.dashboard.create`), overview dashboards |
| **`analytics.explainChange` — the killer capability** | NEW | deterministic contribution decomposition (metric delta attributed by product/customer/category; contributions sum to delta — property-tested); model narrates, then offers a governed action → M12.1 |
| "Ask your business" composition | NEW | extractors + signals + explainChange + skills; answers cite rows and end in proposed actions → M12.2 |
| Automated weekly/monthly business review | NEW | routine (ADR 0031) renders review via renderReport → notification/email → M12.2 |
| Forecasting (sales, cash flow, inventory) | NEW | deterministic erp-core functions (M8.2, M10.3); model never computes |
| Drill from insight → transactions | PARTIAL | ledger viewer + evidence links exist; wire into explainChange results → M12.1 |
| KPI goals/targets, cohort/funnel analysis, budget vs actual | DEFERRED | unless budgeting is pulled forward |

## 2. Milestone sequence

M7–M9 are frozen in `docs/REVENUE_SUITE_PLAN.md` (inventory integrity →
signals + reorder intelligence → quote-to-cash + CRM depth). This section
extends the sequence. Every milestone: unlazy gates written first, repo
verification gate, a demo proof, and at least one subset-org run (§0.3).

### M10 — Accounting & purchasing depth ("trustworthy money, memorable suppliers")

- **10.1 Cash flow statement + credit notes.** Direct-method cash flow from
  the ledger (erp-core, property-tested: ending cash ties to balance sheet);
  AR + AP credit notes as reversal-style documents with approval gates and
  declared inverses.
  - G10.1a `CHECK: pnpm --filter @chaste/erp-core test -- cashflow` / `EXPECT: "cashflow-ok"`
  - G10.1b `CHECK: pnpm demo:m10` / `EXPECT: "CASHFLOW TIES"`
- **10.2 Statements, reminders, terms; supplier memory.** Customer/supplier
  statements as rendered reports; payment-terms fields driving due dates;
  invoice reminders via the notification seam as a routine (respects opt-out);
  supplier lead-time + on-time-rate derived from receipts; purchase backorder
  flag; purchase returns (reversal-style).
  - G10.2a `CHECK: pnpm --filter @chaste/module-purchasing test -- supplier-memory` / `EXPECT: "supplier-memory-ok"`
  - G10.2b `CHECK: pnpm demo:m10` (statements scenario) / `EXPECT: "STATEMENTS OK"`
- **10.3 Money intelligence.** Anomaly/duplicate detection on ledger and
  expenses (deterministic stats, thresholds in org policy) → signals;
  13-week cash-flow forecast (erp-core: AR receipts, AP dues, recurring) with
  "can we afford this purchase?" composition; supplier price-history report
  (analytics extractor) powering "are we overpaying?".
  - G10.3a `CHECK: pnpm --filter @chaste/erp-core test -- forecast` / `EXPECT: "forecast-ok"`
  - G10.3b `CHECK: pnpm demo:m10` (forecast scenario) / `EXPECT: "AFFORD CHECK OK"`

### M11 — People, projects, expenses ("run the business, not HR bureaucracy")

- **11.1 HR structure.** Departments/positions/manager on employees;
  directory UI; employee documents via the documents seam; emergency contacts.
  - G11.1 `CHECK: pnpm --filter @chaste/module-hr test -- structure` / `EXPECT: "hr-structure-ok"`
- **11.2 Attendance + leave polish.** Check-in/out actions on timeEntries with
  late indicators; leave balances derived + calendar UI; attendance-anomaly
  signals (deterministic).
  - G11.2 `CHECK: pnpm --filter @chaste/module-hr test -- attendance` / `EXPECT: "attendance-ok"`
- **11.3 Recruitment-lite.** Openings, applicants, stage pipeline (CRM kanban
  pattern), hire → employee conversion; AI summaries draft-only.
  - G11.3 `CHECK: pnpm --filter @chaste/module-hr test -- recruitment` / `EXPECT: "recruitment-ok"`
- **11.4 Manufacturing planning-lite.** Material-availability check (BOM
  explosion vs stock, deterministic); production steps + work-center field;
  lead-time estimate from run history; "can we produce 500 units?" answers
  with the arithmetic.
  - G11.4 `CHECK: pnpm --filter @chaste/module-manufacturing test -- availability` / `EXPECT: "availability-ok"`
- **11.5 Projects module (greenfield, small).** Projects/tasks/subtasks,
  assignment, due/priority/status, kanban + list (reuse CRM DnD), activity
  from the event ledger; optional timeEntries link (module-aware); AI status
  summaries; "extract tasks from this thread" draft-only via messaging reads.
  - G11.5a `CHECK: pnpm --filter @chaste/module-projects test` / `EXPECT: "projects-ok"`
  - G11.5b `CHECK: pnpm demo:m11` (projects scenario, subset org without HR) / `EXPECT: "PROJECTS STANDALONE OK"`
- **11.6 Expenses depth.** Real categories; receipt attachment via documents
  seam (degrades without Documents); policy limits → approval routing;
  duplicate-claim detection (deterministic); rules-first auto-categorization
  extending the suggestCoding pattern.
  - G11.6 `CHECK: pnpm --filter @chaste/module-accounting test -- expenses` / `EXPECT: "expenses-depth-ok"`
- Demo proof: `pnpm demo:m11` — hire → assign to project → log time → expense
  claim with receipt → approve → payroll; subset matrix run included.

### M12 — Understanding ("BI is dead, long live the business review")

- **12.1 `analytics.explainChange` — the killer capability.** Deterministic
  contribution decomposition: metric delta attributed across dimensions
  (product, customer, category, period); contributions sum to the delta
  (property-tested in erp-core); results drill to underlying transactions;
  the model narrates the decomposition and proposes one governed action.
  - G12.1a `CHECK: pnpm --filter @chaste/erp-core test -- explain-change` / `EXPECT: "explain-change-ok"`
  - G12.1b `CHECK: pnpm demo:m12` / `EXPECT: "DECOMPOSITION SUMS"`
- **12.2 "Ask your business" + scheduled reviews.** Composition surface:
  extractors + signals + explainChange + skills; every answer cites rows and
  ends with a proposed governed action (e.g. "prepare a follow-up list" →
  tasks via M9.3 + draft email); weekly/monthly review as a routine rendering
  through renderReport → notification/email.
  - G12.2 `CHECK: pnpm demo:m12` (ask scenario) / `EXPECT: "ASK-ANSWER CITED"`
- **12.3 Helpdesk ticketing depth.** Ticket fields (number/priority/category/
  assignee/SLA-lite dueAt), canned responses, internal notes, KB authoring;
  auto-categorization rules-first with draft suggestions; similar-ticket
  retrieval via searchMemory; overdue-ticket signals.
  - G12.3 `CHECK: pnpm --filter @chaste/module-support test -- tickets` / `EXPECT: "tickets-ok"`
- **12.4 Documents as the business document layer.** Folders, metadata with
  business-record links (refType/refId), preview/download, append-only version
  history, expiry metadata → expiry signals; cross-document Q&A with explicit
  citations.
  - G12.4 `CHECK: pnpm --filter @chaste/module-documents test -- metadata` / `EXPECT: "documents-metadata-ok"`
- Demo proof: `pnpm demo:m12` — the audit's marquee, verbatim: revenue down
  12% → decomposed to Product A and 14 repeat customers → three not seen in
  45+ days → "prepare a follow-up list?" → tasks + drafts created on approval.

### M13 — Retail & reach (demand-gated)

- **13.1 POS completion.** Returns (reversal + stock back), receipt
  render/print, line-level discounts/taxes verification, multiple payment
  methods, register barcode lookup (uses M7.3).
  - G13.1 `CHECK: pnpm --filter @chaste/module-pos test -- returns` / `EXPECT: "pos-returns-ok"`
- **13.2 Registers & locations.** Registers-as-locations verify; shift
  summaries; POS reports via analytics extractors.
  - G13.2 `CHECK: pnpm demo:m13` / `EXPECT: "REGISTER OK"`
- **13.3 Marketing-lite (only on confirmed demand).** Segments as saved
  deterministic filters; campaigns via the email seam; opt-out honored;
  send-log analytics; AI copy draft-only. Explicitly no tracking pixels, no
  journeys, no landing pages.
  - G13.3 `CHECK: pnpm --filter @chaste/module-marketing test` / `EXPECT: "marketing-lite-ok"`

## 3. Aggregate not-building list (all audits ④/⑤, reconciled with ours)

- Enterprise WMS: zones, bins, put-away, wave/batch picking, routings engines,
  warehouse automation/IoT, 3PL, EDI.
- Enterprise finance: multi-company consolidation, cost centers/analytic
  accounting, deferred revenue/expenses, advanced assets, intrastat.
- Enterprise HR: benefits, succession, competency frameworks, shift planning.
- Enterprise manufacturing: MRP, MPS, capacity engines, quality management,
  subcontracting, make-to-order engineering.
- CRM/Sales bloat: territories, quotas, commissions, multi-pipeline, custom
  objects, workflow-rule engines, e-signature, quote templates/comparison.
- Marketing: everything beyond send-log email (no pixels, no journeys).
- POS: offline mode (explicitly rejected), loyalty, gift cards, kitchen/tables.
- Projects: Gantt, dependencies engine, portfolio, client portal.

## 4. ADRs to write (at their slice start)

- 0033 `inventory-gl-integration` (M7.1) — periodic first; retires ADR 0009's
  deferral.
- 0034 `needs-attention-signal-registry` (M8.1) — deterministic producers,
  many consumers.
- 0036 `sales-order-fulfillment-model` (M9.2) — reservation-anchored SO.
- 0036 `module-composition-conformance` (M8.0) — this plan's §0.3 as enforced
  rules: no sibling imports, graceful degradation, subset matrix, AI-as-tissue.
- Others (credit notes, cash flow method, ticketing fields, projects schema)
  decided in their slices.

## 5. Open decisions for the owner

1. GL posting cadence (from revenue plan): on-demand + period-close
   (recommended).
2. Leads one-object vs separate table (revenue plan §8.2; recommended:
   one-object).
3. Invoice timing (revenue plan §8.3; recommended: invoice-on-delivery).
4. **Projects in M11.5** — include (recommended; small, your own ops likely
   use it) or drop until a customer asks.
5. **Marketing-lite in M13.3** — include only on confirmed demand
   (recommended) or cut from the plan entirely.
6. Recruitment-lite (M11.3) — build (recommended, kanban is cheap) or defer.
7. Expiry-on-lots pull-forward (revenue plan §8.4) — keep tier ④ unless first
   FMCG/pharma customer is real.
8. Camera scanning post-M9 — confirm deferral.

## 6. Process (long-running engagement rules)

- One milestone at a time; within it, one slice at a time. Each slice:
  `GATES.md` from the unlazy leaf template first (specs in these plans are
  the source), four-pass implementation, `--reverify` before done, repo
  verification gate (`pnpm typecheck && pnpm lint && pnpm test`).
- Rolling dispatch across slices when dependencies verify (unlazy
  orchestration rules); `PLAN.md` per milestone tracks slice states.
- Every milestone ends with: demo proof + at least one subset-org run +
  CHANGELOG entry + ROADMAP checkboxes ticked only on gate evidence.
- Standing principle added to ROADMAP: modules useful alone, exponential
  together, AI as connective tissue — enforced by ADR-0035 conformance.





