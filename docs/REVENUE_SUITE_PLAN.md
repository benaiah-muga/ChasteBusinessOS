# Revenue Suite Plan — Inventory · Sales · CRM (M7–M9)

Status: proposed (awaiting owner sign-off) · 2026-08-30

Input: three external feature-audit checklists (Inventory, CRM, Sales) written
**without codebase access**, triaged item-by-item against the code as built.
Companion reading: `ARCHITECTURE.md`, `ROADMAP.md`, ADR 0009 (stock ledger),
ADR 0026 (manufacturing split), ADR 0029 (governed analytics), ADR 0031 (routines).

## 0. Ground rules (inherited, non-negotiable)

1. One execution path: every write is a kernel capability (`module.action` id,
   intent, inverse). Verified: `/api/quotes` is a thin adapter executing
   `accounting.createQuote/acceptQuote/declineQuote` through the registry —
   quotes are governed. M9.1's open question is therefore only their home/ids
   (`accounting.*` vs a `sales.*` re-home), not a governance gap.
2. Domain math is deterministic and property-tested in `packages/erp-core`.
   LLMs narrate, compose, and propose; they never compute money or quantities.
3. Money = integer minor units; quantities = integer thousandths. No floats.
4. Append-only ledgers; corrections are reversals; money/destructive actions
   carry approval gates and declared inverses.
5. If the agent can't do it honestly, it files a ticket.

## 1. Triage of the expert audits

### 1.1 Inventory

| Expert item | Verdict | Evidence / action |
|---|---|---|
| Ledger, movements, history, ATP, reservations, cycle counts, locations, lots, valuation | BUILT | `modules/inventory` (15 capabilities), ADR 0009, M6.5 |
| Suppliers, POs, 3-way match, partial receipts | BUILT | `modules/purchasing`, `matchThreeWay` in erp-core |
| Manufacturing consumes/produces | BUILT | ADR 0026, shared stock writer |
| Reorder points + alerts | PARTIAL | `needsReorder()` only; no velocity/lead-time math → M8.2 |
| **Accounting integration (GL)** | **MISSING — top priority** | ADR 0009 deferred it deliberately; valuation now proven → M7.1 |
| **Internal transfers** | MISSING (audit says Essential — agreed) | no transfer capability exists → M7.2 |
| Product images / tags / barcode field | NEW | cheap columns + lookup capability → M7.3 |
| Variants, full UoM, FIFO, camera scanning | ADAPTED / DEFERRED | correctness surface vs checklist optics — §6 |
| Zones/bins/picking/routes, EDI, 3PL | REJECTED (audit tier ⑤) | matches ARCHITECTURE non-goals |

Key correction to the audit: it buried "accounting should understand
inventory's value" in tier ②. In this codebase that is *the* known
architectural gap (ADR 0009's deferral), so it goes first.

### 1.2 CRM

| Expert item | Verdict | Evidence / action |
|---|---|---|
| Customers, 6-stage pipeline, kanban DnD, weighted forecast, pipeline report | BUILT | `crm.*` capabilities, `deals` table (M2/M3) |
| Leads: source, owner, conversion | PARTIAL | `deals.stage` already models `lead`; add source/owner/lost-reason + explicit conversion → M9.3 |
| Activities (tasks / calls / follow-ups, due dates) | MISSING | light `tasks` table + signals → M9.3 |
| Lost reason, assignment | MISSING | columns on deals → M9.3 |
| Customer 360 (purchases, quotes, payments, tickets, timeline) | PARTIAL | data exists across modules; no assembled read → M9.4 |
| Duplicate detection | NEW | deterministic normalized name/email/phone match, property-tested → M9.3 |
| Deterministic lead scoring | DEFERRED | must be an erp-core function with visible inputs before any AI recommends |
| Email integration, open/click tracking, WhatsApp/SMS | DEFERRED | messaging module is the seam; external sync later |
| Territories, quotas, commissions, multi-pipeline, custom objects | REJECTED (audit ④/⑤) | |

### 1.3 Sales

| Expert item | Verdict | Evidence / action |
|---|---|---|
| Quotes with numbering/status → invoice conversion | BUILT (governed) | `accounting.createQuote/acceptQuote/declineQuote/listQuotes` + thin `/api/quotes` adapter; accept converts "verbatim" per schema comment → M9.1 |
| POS cash/card sales decrementing stock | BUILT | `pos.completeSale`, same-transaction stock decrement, oversell-refusing |
| Invoicing, AR aging, payments | BUILT | accounting module (M2) |
| **Sales orders + delivery / partial fulfillment / backorders** | MISSING | the spine's missing link → M9.2 (light: SO = reservation + delivery anchor) |
| Customer-specific pricing | PARTIAL | `items.salePriceMinor` prefills lines; per-customer override column → M9.2 |
| Credit checking on orders | NEW | AR balance vs `creditLimitMinor`; over-limit → approval, not silent refusal → M9.2 |
| Customer portal | PARTIAL | `/api/portal` exists; keep minimal |
| Templates, e-signature, quote comparison, subscriptions, EDI | REJECTED / DEFERRED | §6 |

### 1.4 On forecasting: "Odoo does it without AI — wouldn't we be ahead?"

Odoo's replenishment is deterministic min/max orderpoints plus
confirmed-demand forecasting — no AI, correct. So our reorder math (M8.2) is
**parity, not edge**, and it's table stakes: we build it anyway, because
without it every AI answer about stock is vibes.

The edge over Odoo is the loop and the surface, not the math:

- Odoo's automation quietly creates RFQs or shows a Replenishment report you
  must open. Ours produces a **signal** (needs attention), a **plan** with
  visible arithmetic, **draft POs**, and a **policy-gated approval** — audited,
  reversible, identical path for human and agent.
- Every suggestion carries evidence rows (velocity window, lead time, safety
  stock, on-hand, incoming). "Why?" is answered with numbers, never with a
  model's confidence.
- Deterministic core means the LLM cannot hallucinate a quantity; it can only
  mis-narrate one, and the receipt is right there.

So: yes, implement — but only M8.1 + M8.3 make us *ahead*; M8.2 alone makes us
Odoo-shaped. We will not market "AI forecasting"; we ship deterministic
forecasting with an AI interface.

## 2. The spine we are completing

The audit's boundary chain, annotated with build state:

```
Lead ─→ Opportunity ─→ Customer      M9.3 (fields + conversion; pipeline exists)
     ─→ Quotation                    built; governed capabilities M9.1
     ─→ Sales Order                  M9.2 (light)
     ─→ Reservation → Delivery       M9.2 (reservation primitives exist; delivery new)
     ─→ Invoice → Payment            BUILT (M1/M2)
Stock movement ← every step          BUILT (shared writer, ADR 0009)
        → GL                         M7.1 (the missing tail)
```

Principle preserved: modular underneath, simple on the surface — the user
never has to learn this diagram. "John wants 50 chairs, prepare everything"
composes it through governed capabilities with receipts, and every step stays
visible, auditable, and manually controllable.

## 3. M7 — Inventory integrity: "books that see the warehouse"

Goal: the balance sheet reflects the warehouse; multi-location stock moves;
product identity is complete enough for real shops.

### Slice 7.1 — Inventory → GL closure (top priority)

- Periodic valuation posting: at period close (or on demand) post a summary
  journal — DR inventory asset / CR COGS relief & adjustments — derived from
  the stock ledger. ADR-0033 draft position: **periodic first**; perpetual
  COGS-at-sale waits until cost-layer policy settles (moving average is the
  only method until then).
- `erp-core`: pure reconciliation — replay ledger → valuation state vs GL
  inventory account balance → variance report (zero unless adjustments posted).
- Capability `inventory.postValuationSummary`: risk `money`, approval-gated,
  inverse = reversal entry. Blocked when derived variance ≠ 0.

Gates (spec — materialized into `GATES.md` from the unlazy leaf template when
the slice starts):

- **G7.1a** reconciliation property: randomized mixed activity → variance = 0
  - `CHECK: pnpm --filter @chaste/erp-core test -- gl-reconciliation`
  - `EXPECT: "reconciliation-ok"` (exit 0)
- **G7.1b** end-to-end: seeded org, 30 days of purchases/sales/adjustments →
  post summary → trial balance balances AND inventory GL account equals stock
  report value
  - `CHECK: pnpm demo:m7`
  - `EXPECT: "M7 RECONCILED"`
- **G7.1c** guard: posting refused when injected drift makes variance ≠ 0
  - `CHECK: pnpm --filter @chaste/module-inventory test -- valuation-guard`
  - `EXPECT: "posting-refused"`

### Slice 7.2 — Internal transfers

- `inventory.createTransfer` (pending) → `inventory.confirmTransfer`: paired
  −out/+in legs in one transaction; partial confirm supported; inverse =
  compensating transfer; reuses existing availability (oversell) guard;
  optional approval when the source location would go negative.
- Transfer history + pending list in the Inventory UI (Stock tab).

Gates:

- **G7.2a** property: a transfer never changes total on-hand, only its
  distribution across locations
  - `CHECK: pnpm --filter @chaste/erp-core test -- transfers`
  - `EXPECT: "transfers-ok"`
- **G7.2b** demo: partial confirm shows correct per-location balances, one
  audit chain
  - `CHECK: pnpm demo:m7` (transfer scenario)
  - `EXPECT: "TRANSFER OK"`

### Slice 7.3 — Product surface

- `items` gains `imageUrl`, `tags`, `barcode` (unique per org) + read
  capability `inventory.lookupByBarcode`; receipt notes on goods receipts
  (verify column state at slice start).
- Product UI: thumbnail, tags, barcode field. Camera scanning stays tier ②.

Gates:

- **G7.3a** barcode lookup hits the right item and fails honestly on miss
  (positive control first)
  - `CHECK: pnpm --filter @chaste/module-inventory test -- barcode`
  - `EXPECT: "barcode-ok"`
- **G7.3b** runtime: create product with image+tags+barcode, visible in list
  (verified per next-dev-loop against the dev server)
  - `CHECK: pnpm demo:m7` (product scenario)
  - `EXPECT: "PRODUCT SURFACE OK"`

## 4. M8 — Signals + reorder intelligence (the marquee)

### Slice 8.1 — "Needs Attention" signal registry (ADR-0034)

- Registry of deterministic per-module **producers**; one shape:
  `{ id, severity: red|orange|green, module, subject, evidenceLink,
     suggestedAction?: { capabilityId, inputDraft } }`. Derived from live
  data; no LLM in the compute path.
- Consumers: home dashboard needs-you queue, per-app overview lists, routines
  findings (ADR 0031), and agent context via read capability `signals.list`.
- Inventory signals first: stockout-within-N-days (velocity × lead time vs
  on-hand + incoming), dead stock (no outbound in X days × value tied up),
  anomalous adjustments (variance outside tolerance), overstock vs velocity.
  Port existing accounting/CRM attention lists onto the registry.

Gates:

- **G8.1a** every producer passes conformance and returns a valid shape on a
  fixture org (property test)
  - `CHECK: pnpm --filter @chaste/kernel test -- signals`
  - `EXPECT: "signals-ok"`
- **G8.1b** home dashboard renders ≥3 inventory signals with evidence links
  - `CHECK: pnpm demo:m8`
  - `EXPECT: "SIGNALS RENDERED"`

### Slice 8.2 — Reorder math in erp-core (the Odoo-parity part)

- Pure functions: `averageDailyDemand(history, windowDays)`,
  `leadTimeDemand(demand, leadTimeDays)`,
  `safetyStock(demandStdDev, leadTimeDays, serviceLevel)`,
  `suggestedOrderQty({ onHand, incoming, targetStock })` =
  `max(0, target − onHand − incoming)`.
- Property tests: never negative; monotonic in demand and lead time;
  idempotent; integer thousandths throughout; respects max-stock cap.

Gates:

- **G8.2a** property suite green
  - `CHECK: pnpm --filter @chaste/erp-core test -- reorder`
  - `EXPECT: "reorder-math-ok"`
- **G8.2b** golden fixture: known 90-day history → expected qty per item
  - `CHECK: pnpm --filter @chaste/erp-core test -- reorder-golden`
  - `EXPECT: "golden-match"`

### Slice 8.3 — Governed reorder loop (the Odoo-beating part)

- Upgrade the existing advisory `stock-reorder` skill into the governed loop:
  read signals + math outputs → compose plan (items, qty, preferred supplier
  from last PO price, budget total in minor units) → present → on approval,
  draft POs per supplier via existing `purchasing` capabilities → money
  policy applies as usual.
- The agent answers the marquee question with citations: "7 products at risk;
  plan = UGX X; create the POs?" — every number comes from 8.2, never from the
  model.

Gates:

- **G8.3a** seeded org, scripted velocity → plan lists exactly the at-risk
  items; approving creates POs whose lines match the plan; books still balance
  - `CHECK: pnpm demo:m8`
  - `EXPECT: "PLAN→POs OK"`
- **G8.3b** decline path: rejecting creates nothing, decision audited
  - `CHECK: pnpm demo:m8 --decline`
  - `EXPECT: "DECLINE AUDITED"`

## 5. M9 — Quote-to-cash completed + CRM depth

### Slice 9.1 — Quote lifecycle consolidation (corrected)

- Verified: quotes already run through governed capabilities
  (`accounting.createQuote/sendQuote`-equivalent, `acceptQuote`, `declineQuote`)
  via a thin `/api/quotes` adapter — no governance gap. Remaining work:
  decide home/ids (`accounting.*` kept vs `sales.*` re-home — capability ids
  are embedded for intent search and referenced by advisory skills, so a
  rename has migration cost; default: **keep ids, document the home**),
  add expiry handling (auto-decline past validity → signal), verify the
  accept-inverse (cancel/credit path) is declared and conformant.

Gates:

- **G9.1a** conformance: quote capabilities pass `assertWellFormedCapability`
  at boot with declared inverses (registry boot check is the oracle)
  - `CHECK: pnpm --filter @chaste/module-accounting test -- quotes`
  - `EXPECT: "quotes-conformance-ok"`
- **G9.1b** quote → accept → invoice → payment leaves a balanced trial balance
  - `CHECK: pnpm demo:m9`
  - `EXPECT: "QUOTE2CASH OK"`

### Slice 9.2 — Sales orders + fulfillment (light)

- `sales_orders` as the contract between sales and inventory: confirm →
  reserve stock (existing reservation primitives); `sales.deliverOrder`
  (full/partial) consumes the reservation, writes movements via the shared
  writer, and invoices (default: invoice-on-delivery — see §8.3); backorder
  flag when undersupplied (flag, not a document zoo); cancel → release
  reservations.
- Customers gain `creditLimitMinor`; confirming an order over limit routes to
  approval instead of failing silently.

Gates:

- **G9.2a** property: concurrent orders can never oversell (extends existing
  reservation tests)
  - `CHECK: pnpm --filter @chaste/erp-core test -- reservations`
  - `EXPECT: "no-oversell"`
- **G9.2b** demo: order 50 chairs → partial deliver 30 → invoice 30 → deliver
  the rest; stock, AR, and GL consistent at every step
  - `CHECK: pnpm demo:m9` (fulfillment scenario)
  - `EXPECT: "FULFILLMENT OK"`

### Slice 9.3 — CRM depth (lean)

- `deals` gains `source`, `ownerUserId`, `lostReason`; **leads = deals in early
  stages** (deliberate one-object choice, §8.2); `crm.convertLead` marks
  qualified and optionally creates the customer record.
- Light `tasks` table (subject, dueAt, doneAt, refType/refId, assigneeUserId)
  + `crm.createTask` / `crm.completeTask`; overdue tasks become signals.
- Duplicate detection: deterministic normalized name/email/phone similarity in
  erp-core; warns on `crm.createCustomer`.

Gates:

- **G9.3a** conversion moves lead → customer without duplicating records;
  lost-reason set on loss is preserved in reports
  - `CHECK: pnpm --filter @chaste/module-crm test`
  - `EXPECT: "crm-depth-ok"`
- **G9.3b** duplicate detector golden fixture: known dupes flagged, distinct
  pairs passed (positive control before trusting absence)
  - `CHECK: pnpm --filter @chaste/erp-core test -- duplicates`
  - `EXPECT: "duplicates-ok"`

### Slice 9.4 — Customer 360 (read-only)

- `crm.customerTimeline` read capability assembling invoices, quotes,
  payments, deals, tasks, support threads, and messages into one dated,
  sourced feed — an analytics extractor underneath (ADR 0029 pattern). Powers
  "summarize this customer" with citations.

Gate:

- **G9.4** timeline returns merged, dated, sourced rows for the fixture org;
  the agent can cite it
  - `CHECK: pnpm demo:m9` (timeline scenario)
  - `EXPECT: "TIMELINE OK"`

## 6. Explicitly not building (adopted from the audit's ④/⑤, plus ours)

- WMS depth: zones, bins, put-away, wave/batch picking, warehouse routes.
- FIFO / landed costs — moving average only until a named customer needs
  otherwise.
- Product variants; multi-dimensional UoM (display-level `unitLabel` already
  exists and is enough).
- Camera barcode scanning (fields + lookup first).
- Commissions, quotas, territories, multi-pipeline, custom objects, workflow-
  rule engines, enterprise forecasting systems.
- Email open/click tracking; external email/WhatsApp sync.
- Subscriptions beyond the existing `recurring` billing routes (re-verify at
  M9 start; extend only on demand).
- Enterprise EDI / 3PL.

## 7. ADRs to write (at slice start, not before)

- **0033 `inventory-gl-integration`** — periodic summary vs perpetual COGS;
  draft position: periodic + property-tested reconciliation; retires ADR
  0009's deferral.
- **0034 `needs-attention-signal-registry`** — one registry, many consumers;
  producers deterministic; signals are advisory, actions still governed.
- **0036 `sales-order-fulfillment-model`** — reservation-anchored SO,
  invoice-on-delivery default, backorders as a flag.

## 8. Open decisions for the owner

1. **GL posting cadence**: on-demand + period-close (recommended) vs scheduled
   job.
2. **Leads**: one-object (deals with early stages — recommended) vs a separate
   `leads` table.
3. **Invoice timing**: invoice-on-delivery (recommended) vs invoice-on-confirm.
4. **Expiry dates on lots**: pull into M7 if the first FMCG/pharma customer is
   real (cheap add to existing lots); otherwise stays tier ④.
5. **Camera scanning**: confirm deferral to a dedicated UI slice post-M9.

## 9. Process

- Each slice: write `GATES.md` from the unlazy leaf template **first** (the
  gate specs above are the source), implement all four passes, then re-run
  runnable gates with `--reverify` before declaring the slice done. Approval
  of every `CHECK:` command happens per the unlazy inspection flow.
- Repo verification gate before any "done":
  `pnpm typecheck && pnpm lint && pnpm test`.
- New demo runners follow the existing `pnpm demo:*` pattern (M7/M8/M9) and
  print exactly the decisive tokens their gates `EXPECT`.



