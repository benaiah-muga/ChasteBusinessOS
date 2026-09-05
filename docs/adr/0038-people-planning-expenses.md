# ADR 0038: People, planning, and expense decisions

Date: 2026-08-31
Status: Accepted (M11)

## Decision

- **HR structure is columns, not a document zoo.** Department, position
  (title), manager (employee self-reference), and emergency contacts live
  on the employee row. One capability updates them; the directory reads
  them.
- **Attendance reuses timeEntries.** clockIn opens an entry, clockOut
  settles the minutes; lateness is a stored flag against a fixed 09:00 UTC
  threshold. Anomaly signals are deterministic (3+ late clock-ins in the
  trailing week → orange) — a nudge toward a conversation, not a verdict.
- **Leave balances are derived** (annual entitlement − approved days taken
  this year); no balance table to drift. The calendar read lists approved
  leave per month.
- **Recruitment-lite:** openings and applicants are two tables; the
  pipeline is a stage column; hire converts the applicant through the same
  employee-insert path as a direct hire and closes the loop with a
  `hiredEmployeeId` link. No model in the compute path.
- **Manufacturing planning is arithmetic.** erp-core/bom.ts already
  exploded BOMs and checked availability for a fixed quantity; M11 adds
  the ceiling (`maxProducibleUnits`) — the honest minimum over per-unit
  component ratios. The capability answers "can we produce N?" with
  requirements, shortfalls, the ceiling, and a lead-time estimate averaged
  from completed-run history (useful even when the answer is no). Work
  orders carry a work-center column.
- **Projects is standalone by construction:** it imports only the kernel
  and the db. Kanban columns are a fixed status set; subtasks are parent
  links; ordering is an explicit position integer. It runs in a subset org
  with every other module disabled, and sibling capabilities refuse.
- **Expenses:** categories are suggested rules-first from the memo
  (deterministic keyword table) with human override; receipts ride the
  documents seam as a stored `documentId` (degrades without Documents);
  per-category policy limits live in `expense_policies` and over-limit
  pending claims raise orange signals; duplicate claims (same person, same
  amount, days apart) pair deterministically like payment duplicates.

## Consequences

- No new balances-to-reconcile: attendance, leave, and supplier-style
  memory all derive from existing ledgers.
- Projects composes with anything and depends on nothing.
- The expense ceiling is a signal, not a block — deliberate approval
  stays the human's call, with the arithmetic attached.
