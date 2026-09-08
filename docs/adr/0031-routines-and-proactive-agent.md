# ADR 0031: Routines, the proactive agent, and Paperclip compatibility

Date: 2026-08-29
Status: Accepted

## Context

Chaste's agent is purely reactive today: it acts only while a human is
typing. Three external harnesses define the state of the art for proactive
agents, and users increasingly expect it:

- **OpenClaw** pairs a persona file (`SOUL.md`) with a heartbeat
  (`HEARTBEAT.md`): a periodic turn in the main session where the model
  surfaces anything needing attention and stays quiet otherwise.
- **Paperclip** (open-source agent orchestration: "if OpenClaw is an
  employee, Paperclip is the company") runs agents on schedules and webhooks
  through its **Routines** layer; a routine does not do work, it creates a
  run.
- **Hermes-style assistants** push findings to the user unprompted.

Adopting any of these naively would break Chaste's core invariant: every
action flows through the governed capability pipeline under least privilege.
A cron that shells out to "the agent" with full authority would be a
governance bypass with a timer on it.

## Decision

**1. Routines are a first-class governed object.** A `routines` table holds a
name, a prompt (what to check each run), and a structured schedule parsed
from natural language. Capabilities (`routines.create/list/update/delete/
runNow`, module `routines`) put routine management inside the same kernel
discipline as everything else, with inverses so creation is reversible.

**2. Scheduling is natural-language-first with a deterministic core.** The
pure parser in `erp-core` (`parseScheduleText`) recognizes the common shapes
("every 30 minutes", "daily at 08:00", "weekdays at 9am", "weekly on monday
at 09:00") and is the only validator. When the words do not fit, the API
falls back to a model normalizer that must emit one of those shapes, which is
re-parsed; if that fails the user gets an honest 422 with examples. We
deliberately did **not** adopt cron expressions or a cron library: interval/
daily/weekly covers real business cadences, reuses the existing
`nextRunAfter`-style math pattern, and avoids a dependency (see ADR 0032).

**3. Execution is the existing Postgres queue, at-most-once.** The worker
tick claims due routines with `FOR UPDATE SKIP LOCKED` and advances
`next_run_at` at claim time, so two workers can never double-fire a routine
(a crashed worker may skip a beat; acceptable for heartbeats). Each run
enqueues `routines.executeRoutine`, which creates a replayable
`agent_sessions` row and runs the standard `runAgentLoop` headlessly.

**4. Routine runs are read-mostly by construction.** The run actor is a
system actor holding a fixed least-privilege bundle: org-wide read
permissions plus `messaging.write` so findings can be posted on the record.
No `accounting.*.write`, no `identity`, no `destructive`. Financial writes
stay in interactive sessions under human approval. A run that finds nothing
replies `NO_ACTION` and stays silent; anything else becomes an in-app
notification linked to the run's session.

**5. SOUL is a per-org column, not a file.** `organizations.agent_soul`
(small text, admin-gated PATCH) carries standing persona instructions. It is
injected into the system prompt framed as preferences that can never override
security rules, approval gates, or financial integrity — the governance
equivalent of OpenClaw's `SOUL.md`, without a filesystem dependency. The
heartbeat ships as a one-click routine preset rather than a special code
path: a daily routine with the OpenClaw-style "surface anything needing
attention, else stay quiet" prompt.

**6. Paperclip compatibility is a webhook capability.** Each routine can own
a secret webhook token; `POST /api/routines/webhook/:token` (no session auth;
the ~128 bits of token entropy are the capability) enqueues a run. Any
external orchestrator — Paperclip routines, cron, CI, Zapier — can therefore
trigger governed Chaste agent runs without Chaste trusting the caller with
anything broader than that one routine.

## Consequences

- The platform is proactive under the same rules as it is reactive: queue →
  executor → ledger → replay, no parallel path.
- Routine runs cost model tokens on a schedule; the read-only bundle and
  `maxSteps: 6` bound the blast radius and the spend.
- `NO_ACTION` discipline depends on prompting, not enforcement; a run that
  chatters creates notifications. If that becomes noisy, gate the
  notification on a structured tool call instead of a text prefix.
- The steer/queue/ask interaction layer (see CHANGELOG) makes the same loop
  usable interactively mid-run, which is the opencode-style counterpart to
  this scheduled layer.
