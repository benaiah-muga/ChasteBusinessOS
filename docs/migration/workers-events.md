# Durable worker and event inventory

This inventory records the current TypeScript behavior for the React and Go
migration. It describes observed source behavior, including existing gaps, so
the Go worker can be compared against the same contract. No worker or data
ownership is changed by this document.

The `graft` executable was unavailable in this checkout. I read the checked-in
graph summaries for `scripts/worker.ts`, jobs, outbox, routines, session events,
and their tests, then checked the exact source spans cited below.

## Worker process

**Source:** `scripts/worker.ts:1-42`.

- **Trigger and cadence:** `pnpm worker` loads repository environment, opens
  the shared database, and loops every 2 seconds when idle. Each pass ticks
  scheduled routines, processes at most one capability job, then at most one
  outbound message. A due routine is enqueued before the job drain, so it may
  run in the same pass.
- **Claiming and concurrency:** Work claiming is in the individual queue
  processors below. A single process calls each processor serially. PostgreSQL
  `SKIP LOCKED` and row fencing permit multiple worker processes to compete.
- **Errors and retries:** A top-level error is logged and followed by a
  2-second delay. Queue-specific retry and reclaim behavior is described
  below.
- **Tests and proofs:** `apps/web/src/server/worker-kill.test.ts:161-285`
  tests processor crash/reclaim behavior. `scripts/gates/routines-e2e.ts:87-138`
  starts and terminates a real worker process, but does not assert graceful
  signal handling. No dedicated SIGINT/SIGTERM drain test was found.
- **Shutdown:** `SIGINT` and `SIGTERM` only set the loop flag. The current
  awaited tick finishes before the loop exits. There is no worker-level abort
  signal, explicit drain deadline, or database-client close in this file.
- **Go parity:** Keep the same processing order and polling behavior unless a
  separately reviewed behavior change is intended. Add a bounded shutdown
  contract that completes or safely leaves the current lease reclaimable.

## Capability jobs

**Sources:** `apps/web/src/server/jobs.ts:12-18,46-73,85-191,193-320`;
table shape in `packages/db/src/schema/index.ts:2710-2747`.

- **Trigger:** `enqueueCapabilityJob` inserts `{orgId, type, payload}` and
  attribution into `jobs`. The live asynchronous document route enqueues
  `documents.parseDocument` (`apps/web/src/app/api/documents/route.ts:102-121`).
  Routine scheduling, manual runs, and webhooks also insert `routines.executeRoutine`
  jobs (covered below). Ordinary job `type` values are capability IDs; the
  worker has a special `routines.executeRoutine` branch before registry lookup
  (`apps/web/src/server/jobs.ts:236-250`).
- **Claim, lease, and fencing:** A claim atomically selects one available
  pending job or expired processing job with `FOR UPDATE SKIP LOCKED`, increments
  `attempts` and `fencing_token`, and records owner and expiry
  (`apps/web/src/server/jobs.ts:100-146`). The default lease is 60 seconds. A heartbeat renews it
  every third of the lease (`apps/web/src/server/jobs.ts:43-44,148-157,201-215`). Finalization
  requires the same job, processing status, owner, and fencing token
  (`apps/web/src/server/jobs.ts:159-187`). Exhausted expired leases are marked failed before the
  next claim (`apps/web/src/server/jobs.ts:85-98,199-204`).
- **Claim transition edge case:** For run-linked jobs, the worker starts the
  heartbeat and performs the initial run/step `running` transitions before
  entering the `try/finally` that clears the heartbeat. If either transition
  throws, the interval is not cleared in this call and the job remains
  processing until lease recovery (`apps/web/src/server/jobs.ts:203-234,236,316-318`).
- **Effect and governance:** Ordinary jobs resolve `type` in the live
  capability registry. Unknown types fail permanently. The worker creates a
  system actor with exactly the capability's declared permission, passes the
  job ID as `intentId`, and runs the capability through `KernelExecutor`,
  including validation, module availability, policy, approval verification,
  audit, and receipts (`apps/web/src/server/jobs.ts:236-269`; `systemActorFor` at `81-83`). A
  linked approval is marked executed after successful execution. This is the
  governed business-effect boundary; direct SQL effects outside it are called
  out in their individual paths below.
- **Idempotency and receipts:** The job ID is the stable action intent. The
  kernel's `(orgId, intentId)` receipt stores the capability, canonical input
  hash, outcome, and result; a repeated job with the same payload replays that
  receipt. A changed capability or payload under the same key conflicts
  (`packages/kernel/src/executor.ts:165-182`; receipt storage in
  `apps/web/src/server/effect-receipts.ts:11-53`). This closes the crash window
  after a receipt but before queue acknowledgement. It does not prevent a
  second effect if a worker is killed during the effect before the receipt is
  durable; the worker-kill test proves the at-least-once case.
- **Retry and reclaim:** Failure returns a non-exhausted job to `pending` with
  exponential delay capped at five minutes; unknown capability IDs fail
  immediately. Default `maxAttempts` is 3. Expired leases are reclaimable only
  while attempts remain. A late worker cannot acknowledge a reclaimed job.
- **Shutdown:** No per-job cancellation is passed to capability execution.
  The process stops taking new passes after the current awaited job/outbox
  calls return; a hard kill leaves lease recovery to the next worker.
- **Tests and proofs:** `apps/web/src/server/jobs.test.ts:47-133` covers
  missing-document failure/retry/exhaustion, empty queue, least privilege,
  reclaim/fencing, and permanent unknown-type failure.
  `apps/web/src/server/worker-kill.test.ts:161-230` proves receipt replay after
  a crash and documents the duplicate-effect window for a mid-flight kill.
  `scripts/gates/durable-po-run.ts:159-224` proves an approved purchase order
  converges to one PO and one receipt after a crash before queue acknowledgement.
- **Go parity:** Reuse the existing `jobs` rows and their status, attempts,
  availability, lease owner/expiry, fencing token, actor attribution, run and
  approval links. Claim and finalize must retain atomic `SKIP LOCKED` and
  owner/token predicates. Keep the capability permission and approval check,
  action key, input hash, receipt semantics, and audit outcomes. Run each
  org-scoped effect in `internal/dbx.WithOrgTx`; the cross-org queue claim
  needs a separately defined trusted dispatcher path that works with RLS and
  the NOBYPASSRLS runtime role.

## Durable agent-run records and job links

**Sources:** `apps/web/src/server/durable-runs.ts:11-21,54-104,106-193`;
`apps/web/src/server/durable-coordinator.ts:53-125`;
`apps/web/src/server/jobs.ts:217-234,270-303`;
tables in `packages/db/src/schema/index.ts:287-317,3176-3206`.

- **Trigger and current reachability:** `agent_runs` and `agent_run_steps`
  store run status, pinned registry/model/harness identity, ordered step input
  hashes, outputs, approvals, and receipt links. The profile-aware coordinator
  verifies and mounts an approved composition, then creates a run row. The
  worker can update linked run/step status when a `jobs` row carries
  `run_id` and `run_step_index`. In inspected production call sites,
  `recordDurableStep` and run-linked job enqueueing are used by tests and
  `scripts/gates/durable-po-run.ts`; the coordinator itself creates the row
  and returns a mounted harness but does not enqueue work or run a durable
  step loop. A general production durable-run dispatcher was not found.
- **Claim, lease, and fencing:** A linked step uses the ordinary capability
  job claim, lease, heartbeat, and fencing described above. Run/step status is
  transitioned to `running` on claim and to committed/failed on completion or
  exhaustion. These status transitions do not have a separate lease.
- **Idempotency and receipt:** `recordDurableStep` uses `(orgId, runId,
  stepIndex)` and a canonical input hash. Same-step/same-input returns the
  checkpoint; same-step/different-input errors. A committed step can link to
  the kernel action receipt and approval. The database unique key is
  `(run_id, step_index)`. The helper first reads and then inserts without
  handling a concurrent unique-key conflict, so replay is idempotent for
  sequential retries but simultaneous first writers can race and one can fail
  with a database uniqueness error (`apps/web/src/server/durable-runs.ts:114-153`;
  unique index in `packages/db/src/schema/index.ts:3202-3205`).
- **Effect and retry:** Business effects remain capability jobs. Job retry
  relies on the job ID receipt. There is no observed automatic resume loop
  that reconstructs an entire agent run from step checkpoints.
- **Shutdown:** Harness runtime cleanup is exposed as `dispose()` by the
  coordinator. The shown coordinator has no process signal integration; worker
  job shutdown follows the ordinary queue behavior.
- **Tests and proofs:** `apps/web/src/server/durable-runs.test.ts:36-114`
  covers lifecycle, version-pinned composition identity, same-input replay,
  and changed-input rejection. `scripts/gates/durable-po-run.ts:159-224`
  exercises approval, linked job, receipt replay, and one committed step.
- **Open questions:** Decide whether initial durable run/step transition
  failures should be caught inside the heartbeat cleanup scope. Decide whether
  simultaneous first writes to one run step must return the same checkpoint
  instead of surfacing a unique-key conflict.
- **Go parity:** Preserve run and step records, unique step identity, canonical
  input hashes, pinned profile/composition identity, status transitions,
  approval and receipt links, and worker lease behavior. Before claiming the
  general durable-run feature is migrated, identify its production dispatcher,
  resume/cancel behavior, and any external entry points. Current source does
  not establish those contracts.

## Outbound notification and marketing outbox

**Sources:** `apps/web/src/server/outbox.ts:7-31,33-53,55-198,209-263,265-342`;
notification producer `apps/web/src/server/kernel.ts:229-298,358-381`;
marketing producer `modules/marketing/src/index.ts:112-173`;
table shape `packages/db/src/schema/index.ts:2776-2809`.

- **Trigger:** Approval and ticket notifications enqueue webhook/email
  intents through `createNotificationSink` when their environment settings
  exist. The approval flow writes the approval row, then calls this sink.
  Marketing sends insert recipient-bound email intents and
  `marketing_deliveries` rows together in the capability transaction. The
  worker is the provider dispatcher.
- **Claim, lease, and fencing:** Claims one due `pending` row with
  `FOR UPDATE SKIP LOCKED`, increments attempts and fencing token, and sets a
  60-second lease. Heartbeat and finalization are fenced by owner and token
  (`apps/web/src/server/outbox.ts:77-172,282-309`). Expired `processing` rows become `unknown`,
  rather than being reclaimed for delivery (`apps/web/src/server/outbox.ts:77-90,287-291`).
- **Idempotency, receipt, and effect:** `(orgId, dedupeKey)` prevents duplicate
  intent inserts. Each row has a stable `providerOperationId`; webhooks send
  it as `Idempotency-Key`, and email uses it in the message ID. Provider
  receipts and completion status are stored on the outbox row. Email with a
  `customerId` rechecks the same org, active state, opt-out, and current address
  before sending (`apps/web/src/server/outbox.ts:55-75,209-263,265-280`). Marketing analytics
  count only provider-confirmed `sent` rows (`modules/marketing/src/index.ts:180-210`).
- **Retry and reconciliation:** Webhook 429 returns to pending using a
  clamped `Retry-After` (or 30 seconds). Webhook 4xx fails; 5xx and thrown
  errors become `unknown`. Email success records its message ID; missing SMTP
  config or ineligible recipients fail. Unknown outcomes do not auto-retry;
  `reconcileOutboxMessage` changes only an org-owned unknown row to sent/failed
  with an optional provider receipt (`apps/web/src/server/outbox.ts:174-198,209-263,310-341`).
- **Shutdown:** There is no outbox abort hook. Webhook requests have a
  5-second timeout; SMTP has no timeout specified in this dispatcher. A hard
  kill during provider I/O yields `unknown` after lease expiry, so the worker
  does not blindly resend.
- **Tests and proofs:** `apps/web/src/server/outbox.test.ts:38-143` covers
  dedupe, provider receipt, unknown/reconciliation, approval notifications,
  and dispatch-time marketing opt-out. `apps/web/src/server/worker-kill.test.ts:232-285`
  covers provider-received-before-crash, no automatic resend, late fencing,
  reconciliation, and duplicate enqueue convergence. No dedicated demo script
  that drains this worker was found.
- **Go parity:** Keep the outbox rows, payload validation, dedupe key,
  provider operation ID, lease/fencing, provider receipt, recipient recheck,
  and conservative unknown state. Reconciliation must remain org-bound. Preserve
  the fact that approval/ticket notification insertion currently follows its
  primary write, while marketing's outbox and delivery link are in one
  transaction.
- **Open questions:** A webhook 429 on the last allowed attempt is finalized
  as `pending`, but future claims require `attempts < max_attempts`; no outbox
  exhausted-pending reaper was found (`apps/web/src/server/outbox.ts:109-113,225-232,321-328`).
  `reconcileOutboxMessage` has tests and an exported helper, but no production
  API/UI caller was found. Decide where operations can settle `unknown` rows.
  Customer-facing `sendOrgMail` in `apps/web/src/server/kernel.ts:340-355`
  sends SMTP directly and is not durable/outbox-backed; preserve it as a
  separate behavior or explicitly move it through a reviewed outbox contract.

## Routines and scheduled agent sessions

**Sources:** `apps/web/src/server/routines.ts:19-50,63-144,146-191,193-303`;
capabilities in `modules/routines/src/index.ts:23-43,45-128,180-237,284-325`;
webhook adapter `apps/web/src/app/api/routines/webhook/[token]/route.ts:6-26`.

- **Triggers:** The worker polls scheduled routines. A user can also invoke
  `routines.runNow`, and a secret-token webhook accepts GET or POST. Creating
  a routine with `withWebhook` sets `triggerType` to `webhook`; the scheduler
  selects only `trigger_type = 'schedule'`, so webhook-configured routines
  are externally triggered rather than timer-triggered. Schedule inputs are
  structured as interval, daily, weekdays, or weekly
  (`modules/routines/src/index.ts:35-43,74-125,284-325`).
- **Claim, occurrence, lease, and fencing:** `claimDueRoutines` runs a
  transaction that selects up to 10 due scheduled rows with `FOR UPDATE SKIP
  LOCKED`, inserts one occurrence, inserts its job, links them, and advances
  `nextRunAt` before commit (`apps/web/src/server/routines.ts:63-126`). The occurrence key is
  `(routineId, scheduledAt)`, unique in the database. The execution job then
  receives the standard queue lease and fencing. Manual and webhook triggers
  insert ordinary jobs without occurrence rows (`apps/web/src/server/routines.ts:128-138`,
  `modules/routines/src/index.ts:297-315`).
- **Idempotency and receipt:** Scheduled duplicate scheduler ticks collapse
  at the unique occurrence boundary. Job-level acknowledgements are fenced.
  Routine agent tool calls do not set `ActionContext.intentId`: the routine
  context has only actor/session/time/services and `runAgentLoop` passes that
  same context to `executor.execute` (`apps/web/src/server/routines.ts:219-224`,
  `packages/kernel/src/loop.ts:250-295`). Therefore the job receipt does not
  make those individual tool effects replay-safe if the whole routine job is
  reclaimed after a hard crash. Manual/webhook duplicate triggers also create
  separate jobs, with no occurrence or trigger idempotency key.
- **Effect and boundaries:** A headless run uses a system actor with a fixed
  least-privilege bundle, including read permissions and `messaging.write`,
  and executes model-selected capabilities through the kernel. It creates a
  replay session and records prompt, final answer, and token usage. It passes
  no `onEvent` callback to `runAgentLoop`, so intermediate tool-call/results
  are not appended to `session_events` by this routine path. If the answer is
  not `NO_ACTION`, an in-app notification is inserted best-effort. The
  routine's `TicketSink` inserts tickets directly, an explicitly documented
  exception to the governed capability path (`apps/web/src/server/routines.ts:225-247`).
- **Retry/reclaim:** Scheduled occurrence/job creation is atomic. A scheduled
  routine disabled after enqueue is marked cancelled before execution. Errors
  inside `executeRoutine` are caught, written to routine/occurrence status,
  and not rethrown (`apps/web/src/server/routines.ts:273-277`); the queue therefore marks that job
  done and does not retry the failed routine. A process crash before the catch
  completes leaves the queue job to lease reclaim and can start a new agent
  session. `nextRoutineRun` uses local process time for wall-clock schedules,
  and the schedule schema stores no timezone (`packages/erp-core/src/routines.ts:12-20,135-175`).
- **Shutdown:** Routine execution does not receive the worker's signal or an
  abort signal. Shutdown waits for the current run to return; a hard stop is
  recovered through the job lease.
- **Tests and proofs:** `apps/web/src/server/routines.test.ts:39-75` covers
  competing scheduler ticks and disable-after-queue. `modules/routines/src/schedule.test.ts:4-17`
  covers schedule shape validation. `scripts/gates/routines-e2e.ts:55-131`
  creates a routine, triggers it through the webhook, starts the real worker,
  and checks job completion, session, and notification. Its header says it
  asserts the last routine status, but the current assertions do not read or
  check that field. No routine kill/reclaim proof was found.
- **Go parity:** Preserve schedule parsing and local-time calculation, next-run
  advancement, one-occurrence uniqueness, trigger selection, secret-token
  behavior, permissions, max six model steps, NO_ACTION silence, notification
  and session behavior, and the distinction between caught failures and queue
  failures. Add an RLS-safe global due scan and per-org execution transaction.
  Keep the occurrence and job insert plus next-run update atomic.
- **Open questions:** Confirm whether interval schedules intentionally drift
  from actual claim time: the next time is calculated from `now`, not the
  stored scheduled instant (`apps/web/src/server/routines.ts:80-95`). Define whether webhook/manual
  duplicate calls should remain independent runs. Define the expected replay
  behavior for tool effects after a routine crash, given there is no stable
  tool intent ID. Confirm timezone expectations for wall-clock schedules.

## Document ingestion and OCR

**Sources:** `apps/web/src/app/api/documents/route.ts:89-121`;
`modules/documents/src/index.ts:132-183`;
`packages/ai/src/documents.ts:4-34`.

- **Trigger:** `POST /api/documents` with action `parse` enqueues
  `documents.parseDocument` by default and returns `{queued:true}`. The
  `sync` option runs the same capability in the request instead
  (`apps/web/src/app/api/documents/route.ts:102-121`). The queued route inserts the job and then updates the
  document to `queued`; these two writes are not inside one visible
  transaction.
- **Claim, lease, and fencing:** There is no document-specific claim protocol.
  It uses the generic capability job row with the ordinary job lease,
  heartbeat, retry, receipt, and fencing rules above. Payload contains only
  `documentId`; content is loaded from the existing document row.
- **Idempotency and effect:** `documents.parseDocument` reads by both org and
  document ID. For an uploaded file it calls OCR; for pasted text it uses
  `rawText`. On success it updates parsed markdown/status and, in an org
  transaction, replaces the document's memory chunks with a new embedded
  chunk (`modules/documents/src/index.ts:145-181`). The queued job ID supplies
  the executor receipt key. Repeated parsing is derived-state replacement,
  but provider calls can repeat after a crash before a receipt or on separate
  jobs created by separate parse requests.
- **Retry/reclaim:** Parse failure stores `status=failed` and `parseError`,
  then throws, so the generic queue records the failure and retries up to the
  job attempt limit. A later successful retry clears `parseError` and updates
  status to parsed. Lease expiry is reclaimed through the generic job queue.
- **Shutdown:** OCR has no worker shutdown signal at the capability boundary;
  a hard stop is handled by job lease expiry. The provider call's timeout and
  cancellation behavior should be checked in its adapter before porting.
- **Tests and proofs:** `apps/web/src/server/jobs.test.ts:47-80` tests the
  queue retry path with a deliberately missing document, not successful OCR.
  `scripts/demo-m3.ts:49-59` proves synchronous parsing of pasted text and
  indexing into org memory through direct executor calls; it does not enqueue
  a worker job or exercise uploaded-file OCR.
  `modules/documents/src/m12.test.ts:40-65` covers metadata and append-only
  document versions, not queue processing. `scripts/demo-m12.ts:114-142`
  covers document metadata/versions/signals by direct capability calls and
  does not enqueue parsing. A successful async OCR worker proof was not found.
- **Go parity:** Keep existing document rows and files/text, queued/failed/
  parsed status transitions, OCR provider choice/input/output, deterministic
  chunk replacement and embeddings, org filter, `documents.write` permission,
  error text surfaced to the queue, and job receipt semantics. Define provider
  timeout/cancellation and whether job enqueue plus `queued` status become one
  atomic transaction.

## Other scheduled capability candidate

`accounting.generateDueInvoices` is described as a durable-job worker entry
point. It locks due recurring invoice templates with `SKIP LOCKED`, inserts a
unique `recurring_invoice_runs` occurrence, posts the invoice through the
shared accounting path, advances the schedule, and links the occurrence to
the invoice in one transaction (`modules/accounting/src/index.ts:2338-2417`).
Its occurrence key is `(orgId, recurringInvoiceId, scheduledFor)` and is
covered by `modules/accounting/src/recurring.test.ts:64-82`. The inspected
production worker loop does not schedule it; the only enqueue of this
capability ID found is the test at
`apps/web/src/server/gaps.test.ts:247-260`. Treat its production trigger as an
open question. If it is activated in the target,
preserve the posting capability, unique occurrence, and atomic schedule
advancement; do not silently fold it into the routine scheduler.

## Event and data boundaries

- **Business data versus action audit:** Capabilities own domain writes.
  `KernelExecutor` emits generic lifecycle kinds such as `capability.executed`,
  `capability.failed`, and approval events; the app's `PgLedgerStore` appends
  to a single global hash chain under a transaction advisory lock
  (`packages/kernel/src/executor.ts:151-163,186-259,276-289`;
  `apps/web/src/server/kernel.ts:144-180`). `ledger_events.kind` is the event
  label, not a discovered generic event bus. No general publish/subscribe
  consumer was found in the worker wiring.
- **Ledger rules:** `ledger_events` stores actor, org, capability, payload,
  previous hash, hash, and time (`packages/db/src/schema/index.ts:167-190`).
  Migration `packages/db/drizzle/0000_moaning_ronan.sql:34-46` creates it;
  `packages/db/drizzle/0046_steady_ledger.sql:186-194` forbids update/delete/truncate;
  `packages/db/drizzle/0061_ledger_session_id.sql:1-9` adds session attribution, intentionally
  outside the hash input. `PgLedgerStore` uses one global advisory lock and
  reads the global tail, so do not split into per-org chains without an ADR
  and an explicit audit-history migration plan.
- **Agent trajectory:** `session_events` is an ordered replay log separate
  from `ledger_events` and action receipts. `appendSessionEvent` inserts
  `MAX(seq)+1`, relies on the unique `(session_id, seq)` key, retries a
  collision up to three times, then logs and returns (`apps/web/src/server/session-events.ts:5-34`).
  Tables originate in `packages/db/drizzle/0000_moaning_ronan.sql:110-117,177` and tenant policy
  is in `packages/db/drizzle/0014_rls_everywhere.sql:44-48`.
- **Receipt versus queue versus outbox:** `action_receipts` are governed
  capability outcome records; `jobs` are internal work; `outbox_messages` are
  provider intents with uncertain outcomes. They are separate tables with
  different retry guarantees and must not be collapsed into one generic
  status/event record.
- **Tenant and schema preservation:** Existing tables are org-scoped under
  RLS. Relevant migrations are jobs `0015_deep_fantastic_four.sql` and
  lease fields `0038_mushy_kingpin.sql`, durable run links
  `0056_durable_run_jobs.sql`; routines `0028_crazy_lady_ursula.sql` and
  occurrence receipts `0041_peaceful_gauntlet.sql`; outbox
  `0039_chubby_boomer.sql`; action receipts `0035_action_receipts.sql`; durable
  run/step tables `0055_durable_agent_runs.sql`; documents and suggestions
  `0010_faulty_eddie_brock.sql`, version metadata `0033_m12_understanding.sql`,
  and binary compatibility `0069_document_binary_compat.sql`. The migration
  preserves existing database rows and migration history; it does not create
  replacement worker-owned tables.
- **Cross-tenant scheduler boundary:** Current global queue claims and routine
  scans operate across orgs before a job's `orgId` is known
  (`apps/web/src/server/jobs.ts:107-128`; `apps/web/src/server/routines.ts:69-77`; `apps/web/src/server/outbox.ts:99-117`). The Go port
  must not use tenant context-free business reads under the NOBYPASSRLS
  runtime role. Keep a narrow trusted cross-tenant claim/scheduler mechanism,
  then run each org-owned effect and reconciliation through `WithOrgTx`.
