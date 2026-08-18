# NL request manual-test findings — Nile Gold Bakery (Uganda)

Date: 2026-08-17. All 18 research-doc NL requests driven as the admin user via
`POST /api/v1/ai/chat` against the live API (provider nvidia_nim, autonomy
confirm, allowFullAutonomous=false). Responses captured under `/tmp/opencode/rNN.json`.

## Verdict: none of the 18 requests behaves as specified.

| # | Request | Actual behavior | Status |
|---|---------|-----------------|--------|
| 1 | Remind me every Friday at 4pm to review stockouts | One-shot `core.reminder.set`; **recurrence dropped**, model invented Mon 16:00 EAT | ✗ |
| 2 | Schedule payroll approval for the 25th, and ping Finance if not approved by 3pm | Clarify loop; only a calendar event `for payroll approval` (title mangled); **the 25th, the conditional ping dropped** | ✗ |
| 3 | Every morning, tell branch managers which products are at risk of stockout | No structured intent matched | ✗ |
| 4 | If supplier bills over 5 million arrive, ask me before approval routing | LLM hallucinated `pur.po.create` with invalid fields; standing approval rule dropped | ✗ |
| 5 | Follow up with customers whose invoices are overdue by >14 days, draft for approval | One-shot follow-up; goal = raw condition text; draft-for-approval dropped | ✗ |
| 6 | treat blank tax IDs as unknown | LLM hallucinated `crm.customer.update {taxId}` → VALIDATION_ERROR (boundary caught it; UX message misleading) | ✗ |
| 7 | split full name into first and last name | LLM hallucinated `crm.customer.update {firstName,lastName,fullName}` (invalid fields) | ✗ |
| 8 | these two supplier columns are the same supplier | No structured intent matched | ✗ |
| 9 | show this by branch | No structured intent matched | ✗ |
| 10 | make it monthly | LLM hallucinated `acc.journal.post` with invented fields | ✗ |
| 11 | compare to last quarter | Read `crm.customer.list` (irrelevant dump; raw internal ids leaked) | ✗ |
| 12 | turn this into a dashboard | No structured intent matched | ✗ |
| 13 | send this every Monday | No structured intent matched | ✗ |
| 14 | Open a new branch in Nairobi | LLM proposed `core.branch.create {name, location}` — missing required `code`, bad field → VALIDATION_ERROR | ✗ |
| 15 | inventory is getting low; handle replenishment | No structured intent matched | ✗ |
| 16 | why did margins fall this month? | Read `acc.invoice.list` (irrelevant dump) | ✗ |
| 17 | show monthly sales by branch and schedule this every Monday | No structured intent matched | ✗ |
| 18 | remind branch managers every Friday to review stockouts | Clarify with **raw internal field names** (`fireAt`,`title`) | ✗ |

## Root causes

1. **Deterministic intent parser** (`planSingleSegment`) covers only: reminder
   (one-shot), follow-up (one-shot), calendar block (needs a time RANGE),
   create customer/vendor/product/employee/invoice, prepare payroll. No:
   recurring schedules, day-of-month dates, conditional/compound requests,
   branch/user/role creation, watch rules, analytics, import/data-quality.
2. **LLM assist** (`runAgentToolLoop`) lets the model pick any command but it
   **hallucinates fields not in the zod schemas** (`taxId`, `firstName`,
   `location`, `journalID`, …) and omits required fields (`code`, `customerId`)
   → VALIDATION_ERROR at the boundary (zod invariant works, UX is bad).
3. **No analytics/report read queries** exist (no sales-by-branch, no
   margin/time-series). R11 read path answers only raw object dumps.
4. **Proactive/watch-rule + recurring surfaces are not reachable from chat**
   and **nothing fires them**:
   - Watch rules are created only via `POST /api/v1/proactive/rules` (REST),
     not from chat; the orchestrator deps have no access to the proactive stores.
   - The worker (`apps/worker`) evaluates reminders + follow-ups + email +
     backups + outbox only — **watch rules and `activities` are never fired**.
   - `activities.*` permissions are NOT in `PERMISSION_CATALOG`, so no role
     (not even admin) can run `activities.create`/`activities.read`.
5. **Clarify UX** leaks internal field names (`fireAt`, `title`).

## Gap between research doc and implementation

The research doc's acceptance criteria (proactive scheduling, standing rules,
approval conditions, recurring delivery, dashboards) are implemented as
*durable primitives* (watch rules, recurrence, coordinator, activities) but the
**chat → primitive wiring** and the **runtime firing loop** are absent. The
orchestrator's stated intent surface is a narrow CRUD subset.
